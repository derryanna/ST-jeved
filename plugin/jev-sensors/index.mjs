import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENDPOINT = 'https://api.rout.my/v1/systemone';
const MODEL = 'typesafe/jev-latest';
const KEEP = 60;
const SECRETS_FILE = 'secrets.json';
const CUSTOM_KEYS = 'api_key_custom';
const KEY_LABEL = 'rout';
const KEY_ENV = 'ROUT_API_KEY';
const PASS_TIMEOUT_MS = 60000;
const ASK_TIMEOUT_MS = 20000;

export const info = {
    id: 'jev-sensors',
    name: 'Jev sensors',
    description: 'Holds the Rout key for the Jeved extension and scores replies with TypeSafe Jev through Rout.',
};

export const NO_KEY = 'The jev-sensors plugin found no Rout key. In SillyTavern, open the API key manager, add a custom key whose label starts with "rout" and paste your Rout key as its value. Or set ROUT_API_KEY for the SillyTavern process.';
export const KEY_REJECTED = 'Rout rejected the key stored in the jev-sensors plugin. Save a new one in the API key manager and press Test.';
export const NO_ANSWER = 'Rout did not answer in time.';

export function userRoot(req) {
    const own = req?.user?.directories?.root;
    if (typeof own === 'string' && own) {
        return own;
    }
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' && globalThis.DATA_ROOT
        ? globalThis.DATA_ROOT
        : path.join(process.cwd(), 'data');
    return path.join(dataRoot, 'default-user');
}

function labelledKeys(root) {
    let secrets;
    try {
        secrets = JSON.parse(fs.readFileSync(path.join(root, SECRETS_FILE), 'utf8'));
    } catch {
        return [];
    }
    const list = Array.isArray(secrets?.[CUSTOM_KEYS]) ? secrets[CUSTOM_KEYS] : [];
    return list.filter(item => item
        && typeof item.value === 'string' && item.value
        && String(item.label ?? '').trim().toLowerCase().startsWith(KEY_LABEL));
}

export function routKey(root) {
    const named = labelledKeys(root);
    const hit = named.find(item => item.active) ?? named[named.length - 1];
    return hit?.value || String(process.env[KEY_ENV] ?? '').trim();
}

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value, cap) => String(value ?? '').slice(0, cap);

export function normaliseUsage(data) {
    const usage = data?.usage;
    if (isRecord(usage) && usage.input_tokens == null && usage.prompt_tokens != null) {
        usage.input_tokens = usage.prompt_tokens;
        usage.output_tokens = usage.completion_tokens ?? 0;
    }
    return data;
}

async function askRout(key, body, timeoutMs) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
}

function failure(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return { status: 504, body: { error: NO_ANSWER } };
    }
    return { status: 502, body: { error: str(error?.message || error, 200) } };
}

function questions(user, hasIntent) {
    const q = {
        echo: { type: 'score',
            instructions: 'Compare the prose of latest_reply with the earlier narrator replies and earlier_reply_openings. How much does it reuse the same opening move, sentence patterns, images or closing move? Ignore names, setting details and formatting conventions.',
            criteria: ['Fresh: opening, rhythm and imagery are all new.', 'Slight: one familiar turn of phrase or image.', 'Noticeable: the opening or closing move, or several phrases, repeat an earlier reply.', 'Template: same opening move and same structure as earlier replies.'] },
        change: { type: 'score',
            instructions: 'How much does the situation in the story change in latest_reply compared to the messages before it?',
            criteria: ['Nothing changes; the scene stands still.', 'Minor change: mood or small details only.', 'Moderate change: a new fact, decision or movement.', 'Major change: the scene turns or a new scene begins.', 'Everything changes: a turning point of the whole story.'] },
        fortune: { type: 'score',
            instructions: `How badly do things go for ${user} across all the messages shown?`,
            criteria: ['Things go very well for them.', 'Mostly fine, small friction.', 'Mixed: real setbacks and real wins.', 'Badly: they are losing ground.', 'Disaster: serious harm or loss.'] },
        forme: { type: 'noul',
            instructions: `Does latest_reply write spoken lines, actions or decisions for ${user} (the player's own character) that the player did not write themselves?` },
    };
    if (hasIntent) {
        q.tone = { type: 'score',
            instructions: 'How well do the tone and themes of latest_reply match the intent described in intent?',
            criteria: ['The tone and themes are unrelated to the intent.', 'Mostly different from the intent.', 'Partly matches the intent.', 'Mostly matches the intent.', 'Fully matches the intended tone and themes.'] };
    }
    return q;
}

const storeDir = req => path.join(userRoot(req), 'jev-sensors');
const fileFor = (req, chatId) => path.join(storeDir(req), `${crypto.createHash('sha1').update(String(chatId)).digest('hex')}.json`);

function load(req, chatId) {
    try {
        return JSON.parse(fs.readFileSync(fileFor(req, chatId), 'utf8'));
    } catch {
        return { chat: String(chatId), hist: [] };
    }
}

function save(req, chatId, doc) {
    fs.mkdirSync(storeDir(req), { recursive: true });
    fs.writeFileSync(fileFor(req, chatId), JSON.stringify(doc));
}

export async function init(router) {
    router.post('/systemone', async (req, res) => {
        const b = req.body || {};
        if (!isRecord(b.state) || !isRecord(b.questions)) {
            return res.status(400).json({ error: 'state and questions required' });
        }
        const key = routKey(userRoot(req));
        if (!key) {
            return res.status(401).json({ error: NO_KEY });
        }
        const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : MODEL;
        try {
            const reply = await askRout(key, { model, state: b.state, questions: b.questions }, PASS_TIMEOUT_MS);
            if (reply.status === 401 || reply.status === 403) {
                return res.status(reply.status).json({ error: KEY_REJECTED });
            }
            let data;
            try {
                data = JSON.parse(reply.text);
            } catch {
                return res.status(502).json({ error: `Rout answered ${reply.status} without JSON.`, detail: reply.text.slice(0, 300) });
            }
            return res.status(reply.status).json(normaliseUsage(data));
        } catch (error) {
            const failed = failure(error);
            return res.status(failed.status).json(failed.body);
        }
    });

    router.get('/hist', (req, res) => {
        if (!req.query.chat) {
            return res.status(400).json({ error: 'chat required' });
        }
        res.json(load(req, req.query.chat));
    });

    router.post('/ask', async (req, res) => {
        const b = req.body || {};
        if (!b.chat || !b.latest) {
            return res.status(400).json({ error: 'chat and latest required' });
        }
        const key = routKey(userRoot(req));
        if (!key) {
            return res.status(401).json({ error: NO_KEY });
        }
        const user = str(b.user, 60) || 'the player character';
        const intent = str(b.intent, 2500);
        const state = {
            earlier_reply_openings: (Array.isArray(b.openings) ? b.openings : []).slice(-6).map(t => str(t, 250)),
            previous_messages: (Array.isArray(b.previous) ? b.previous : []).slice(-4).map(m => ({ from: m?.user ? user : 'narrator', text: str(m?.text, 1500) })),
            latest_reply: str(b.latest, 5000),
        };
        if (intent) {
            state.intent = intent;
        }
        try {
            const t0 = Date.now();
            const reply = await askRout(key, { model: MODEL, state, questions: questions(user, !!intent) }, ASK_TIMEOUT_MS);
            if (reply.status === 401 || reply.status === 403) {
                return res.status(reply.status).json({ error: KEY_REJECTED });
            }
            if (!reply.ok) {
                return res.status(502).json({ error: `Rout answered ${reply.status}.`, detail: reply.text.slice(0, 300) });
            }
            const answers = JSON.parse(reply.text).answers || {};
            const s = {};
            for (const k of ['echo', 'change', 'fortune', 'tone']) {
                if (typeof answers[k]?.score === 'number') {
                    s[k] = +answers[k].score.toFixed(2);
                }
            }
            if (typeof answers.forme?.noul === 'number') {
                s.forme = +answers.forme.noul.toFixed(2);
            }
            const doc = load(req, b.chat);
            const entry = { id: Number(b.id), sig: str(b.sig, 80), t: Date.now(), ms: Date.now() - t0, s };
            doc.hist = doc.hist.filter(h => h.id !== entry.id && h.id < entry.id);
            doc.hist.push(entry);
            doc.hist = doc.hist.slice(-KEEP);
            save(req, b.chat, doc);
            res.json(doc);
        } catch (error) {
            const failed = failure(error);
            res.status(failed.status).json(failed.body);
        }
    });
}
