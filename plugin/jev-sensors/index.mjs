// Jev sensors: server side. Keeps the Rout key out of the browser, holds the question set,
// stores per-chat history next to the ST data (NOT inside chat files).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = path.join(process.cwd(), 'data', 'default-user');
const STORE = path.join(DATA, 'jev-sensors');
const ENDPOINT = 'https://api.rout.my/v1/systemone';
const MODEL = 'typesafe/jev-latest';
const KEEP = 60;

export const info = { id: 'jev-sensors', name: 'Jev sensors', description: 'Scores the latest reply with TypeSafe Jev via Rout.' };

function routKey() {
    const sec = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'));
    const list = Array.isArray(sec.api_key_custom) ? sec.api_key_custom : [];
    const hit = list.find(k => String(k.label || '').toLowerCase().startsWith('rout'));
    if (!hit?.value) throw new Error('no Rout key in secrets.json');
    return hit.value;
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

const fileFor = chatId => path.join(STORE, crypto.createHash('sha1').update(String(chatId)).digest('hex') + '.json');
function load(chatId) {
    try { return JSON.parse(fs.readFileSync(fileFor(chatId), 'utf8')); } catch { return { chat: String(chatId), hist: [] }; }
}
function save(chatId, doc) {
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(fileFor(chatId), JSON.stringify(doc));
}
const str = (v, cap) => String(v ?? '').slice(0, cap);

// Rout usage comes back in OpenAI names on some days; Jeved reads input_tokens/output_tokens.
function normaliseUsage(data) {
    const u = data?.usage;
    if (u && typeof u === 'object' && u.input_tokens == null && u.prompt_tokens != null) {
        u.input_tokens = u.prompt_tokens;
        u.output_tokens = u.completion_tokens ?? 0;
    }
    return data;
}

export async function init(router) {
    // Pass-through for the Jeved extension (derryanna/ST-jeved, host "Rout (jev-sensors plugin)"):
    // same systemone body, the key stays here, the answer goes back untouched.
    router.post('/systemone', async (req, res) => {
        const b = req.body || {};
        if (!b.state || typeof b.state !== 'object' || !b.questions || typeof b.questions !== 'object') {
            return res.status(400).json({ error: 'state and questions required' });
        }
        const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : MODEL;
        try {
            const r = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + routKey(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, state: b.state, questions: b.questions }),
                signal: AbortSignal.timeout(60000),
            });
            const text = await r.text();
            let data;
            try { data = JSON.parse(text); } catch { return res.status(502).json({ error: `rout ${r.status} without JSON`, detail: text.slice(0, 300) }); }
            res.status(r.status).json(normaliseUsage(data));
        } catch (e) {
            res.status(502).json({ error: String(e?.message || e).slice(0, 200) });
        }
    });

    router.get('/hist', (req, res) => {
        if (!req.query.chat) return res.status(400).json({ error: 'chat required' });
        res.json(load(req.query.chat));
    });

    router.post('/ask', async (req, res) => {
        const b = req.body || {};
        if (!b.chat || !b.latest) return res.status(400).json({ error: 'chat and latest required' });
        const user = str(b.user, 60) || 'the player character';
        const intent = str(b.intent, 2500);
        const state = {
            earlier_reply_openings: (Array.isArray(b.openings) ? b.openings : []).slice(-6).map(t => str(t, 250)),
            previous_messages: (Array.isArray(b.previous) ? b.previous : []).slice(-4).map(m => ({ from: m?.user ? user : 'narrator', text: str(m?.text, 1500) })),
            latest_reply: str(b.latest, 5000),
        };
        if (intent) state.intent = intent;
        try {
            const t0 = Date.now();
            const r = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + routKey(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: MODEL, state, questions: questions(user, !!intent) }),
                signal: AbortSignal.timeout(20000),
            });
            const text = await r.text();
            if (!r.ok) return res.status(502).json({ error: `rout ${r.status}`, detail: text.slice(0, 300) });
            const a = JSON.parse(text).answers || {};
            const s = {};
            for (const k of ['echo', 'change', 'fortune', 'tone']) if (typeof a[k]?.score === 'number') s[k] = +a[k].score.toFixed(2);
            if (typeof a.forme?.noul === 'number') s.forme = +a.forme.noul.toFixed(2);
            const doc = load(b.chat);
            const entry = { id: Number(b.id), sig: str(b.sig, 80), t: Date.now(), ms: Date.now() - t0, s };
            doc.hist = doc.hist.filter(h => h.id !== entry.id && h.id < entry.id); // swipe/regenerate replaces, branch rewind drops the tail
            doc.hist.push(entry);
            doc.hist = doc.hist.slice(-KEEP);
            save(b.chat, doc);
            res.json(doc);
        } catch (e) {
            res.status(502).json({ error: String(e?.message || e).slice(0, 200) });
        }
    });
}
