import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KEY_REJECTED, NO_ANSWER, NO_KEY, info, init, normaliseUsage, routKey, userRoot } from '../plugin/jev-sensors/index.mjs';

const realFetch = globalThis.fetch;
const realEnv = process.env.ROUT_API_KEY;
let root = '';
let sent = [];

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jeved-plugin-'));
    sent = [];
    delete process.env.ROUT_API_KEY;
});

afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
    delete globalThis.DATA_ROOT;
    if (realEnv === undefined) {
        delete process.env.ROUT_API_KEY;
    } else {
        process.env.ROUT_API_KEY = realEnv;
    }
});

const secret = (label, value, active = false) => ({ id: label, label, value, active });

function secrets(custom) {
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ api_key_custom: custom }));
}

function answer(status, body) {
    globalThis.fetch = async (url, options) => {
        sent.push({ url, options, body: JSON.parse(options.body) });
        return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    };
}

async function routes() {
    const found = {};
    await init({
        post: (path, handler) => { found[`POST ${path}`] = handler; },
        get: (path, handler) => { found[`GET ${path}`] = handler; },
    });
    return found;
}

const request = (body, user = { directories: { root } }) => ({ body, user, query: {} });

function response() {
    const res = { code: 200, body: null };
    res.status = code => { res.code = code; return res; };
    res.json = body => { res.body = body; return res; };
    return res;
}

const ask = { model: 'typesafe/jev-latest', state: { text: 'x' }, questions: { q: { type: 'score' } } };

describe('the plugin module', () => {
    it('describes itself the way the SillyTavern loader expects', () => {
        assert.equal(info.id, 'jev-sensors');
        assert.ok(info.name && info.description);
    });

    it('registers the pass-through and the strip routes', async () => {
        assert.deepEqual(Object.keys(await routes()).sort(), ['GET /hist', 'POST /ask', 'POST /systemone']);
    });
});

describe('where the plugin looks for the key', () => {
    it('uses the data folder of the user who made the request', () => {
        assert.equal(userRoot({ user: { directories: { root: '/srv/st/data/alice' } } }), '/srv/st/data/alice');
    });

    it('falls back to default-user under the configured data root, then under the working folder', () => {
        globalThis.DATA_ROOT = '/srv/st/data';
        assert.equal(userRoot({}), join('/srv/st/data', 'default-user'));
        delete globalThis.DATA_ROOT;
        assert.equal(userRoot(undefined), join(process.cwd(), 'data', 'default-user'));
    });
});

describe('routKey', () => {
    it('is empty without a secrets file, without custom keys, and without a rout label', () => {
        assert.equal(routKey(root), '');
        secrets('not a list');
        assert.equal(routKey(root), '');
        secrets([secret('OpenAI', 'sk-1', true)]);
        assert.equal(routKey(root), '');
    });

    it('finds the key by its label, whatever the case and spacing', () => {
        secrets([secret('OpenAI', 'sk-1', true), secret('  Rout.my ', 'rk-1')]);
        assert.equal(routKey(root), 'rk-1');
    });

    it('prefers the active rout key, else the newest one', () => {
        secrets([secret('rout old', 'rk-old'), secret('rout new', 'rk-new')]);
        assert.equal(routKey(root), 'rk-new');
        secrets([secret('rout old', 'rk-old', true), secret('rout new', 'rk-new')]);
        assert.equal(routKey(root), 'rk-old');
    });

    it('skips a labelled entry with no value, and reads the environment when nothing is labelled', () => {
        secrets([secret('rout', '')]);
        assert.equal(routKey(root), '');
        process.env.ROUT_API_KEY = ' rk-env ';
        assert.equal(routKey(root), 'rk-env');
        secrets([secret('rout', 'rk-file')]);
        assert.equal(routKey(root), 'rk-file');
    });
});

describe('normaliseUsage', () => {
    it('gives OpenAI usage names the names Jeved reads, and leaves the rest alone', () => {
        assert.deepEqual(normaliseUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } }).usage, { prompt_tokens: 10, completion_tokens: 2, input_tokens: 10, output_tokens: 2 });
        assert.deepEqual(normaliseUsage({ usage: { prompt_tokens: 10 } }).usage, { prompt_tokens: 10, input_tokens: 10, output_tokens: 0 });
        assert.deepEqual(normaliseUsage({ usage: { input_tokens: 5, output_tokens: 1, prompt_tokens: 10 } }).usage, { input_tokens: 5, output_tokens: 1, prompt_tokens: 10 });
        assert.deepEqual(normaliseUsage({ answers: {} }), { answers: {} });
        assert.equal(normaliseUsage(null), null);
    });
});

describe('POST /systemone', () => {
    it('refuses a body without state and questions before it looks for a key', async () => {
        answer(200, {});
        const handler = (await routes())['POST /systemone'];
        for (const body of [undefined, {}, { state: {} }, { questions: {} }, { state: 'x', questions: {} }, { state: {}, questions: [] }]) {
            const res = response();
            await handler(request(body), res);
            assert.equal(res.code, 400, JSON.stringify(body));
        }
        assert.equal(sent.length, 0);
    });

    it('answers 401 with the way to store a key when the user has none, and calls nobody', async () => {
        answer(200, {});
        const res = response();
        await (await routes())['POST /systemone'](request(ask), res);
        assert.equal(res.code, 401);
        assert.equal(res.body.error, NO_KEY);
        assert.match(NO_KEY, /API key manager/);
        assert.match(NO_KEY, /ROUT_API_KEY/);
        assert.equal(sent.length, 0);
    });

    it('sends the body to Rout with the key of the requesting user and returns the answer with usage normalised', async () => {
        secrets([secret('rout', 'rk-1', true)]);
        answer(200, { answers: { q: { score: 1.5 } }, usage: { prompt_tokens: 30, completion_tokens: 3 } });
        const res = response();
        await (await routes())['POST /systemone'](request(ask), res);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, 'https://api.rout.my/v1/systemone');
        assert.equal(sent[0].options.headers.Authorization, 'Bearer rk-1');
        assert.deepEqual(sent[0].body, ask);
        assert.equal(res.code, 200);
        assert.deepEqual(res.body, { answers: { q: { score: 1.5 } }, usage: { prompt_tokens: 30, completion_tokens: 3, input_tokens: 30, output_tokens: 3 } });
    });

    it('fills in the default model when the body carries none, and never leaks the key into the answer', async () => {
        secrets([secret('rout', 'rk-1')]);
        answer(200, { answers: {} });
        const res = response();
        await (await routes())['POST /systemone'](request({ ...ask, model: '  ' }), res);
        assert.equal(sent[0].body.model, 'typesafe/jev-latest');
        assert.ok(!JSON.stringify(res.body).includes('rk-1'));
    });

    it('reads the key of the user who asks, not of default-user', async () => {
        secrets([secret('rout', 'rk-test')]);
        answer(200, { answers: {} });
        await (await routes())['POST /systemone'](request(ask, { directories: { root } }), response());
        assert.equal(sent[0].options.headers.Authorization, 'Bearer rk-test');
        const res = response();
        await (await routes())['POST /systemone'](request(ask, { directories: { root: join(root, 'nobody') } }), res);
        assert.equal(res.code, 401);
        assert.equal(sent.length, 1);
    });

    it('turns a refusal from Rout into a message that names the plugin, keeping the status', async () => {
        secrets([secret('rout', 'rk-bad')]);
        for (const status of [401, 403]) {
            answer(status, { error: { message: 'Invalid API key' } });
            const res = response();
            await (await routes())['POST /systemone'](request(ask), res);
            assert.equal(res.code, status);
            assert.deepEqual(res.body, { error: KEY_REJECTED });
        }
    });

    it('passes any other status and its JSON through', async () => {
        secrets([secret('rout', 'rk-1')]);
        answer(429, { error: { message: 'slow down', code: 429 } });
        const res = response();
        await (await routes())['POST /systemone'](request(ask), res);
        assert.equal(res.code, 429);
        assert.deepEqual(res.body, { error: { message: 'slow down', code: 429 } });
    });

    it('answers 502 with the status when Rout sends no JSON', async () => {
        secrets([secret('rout', 'rk-1')]);
        answer(503, '<html>maintenance</html>');
        const res = response();
        await (await routes())['POST /systemone'](request(ask), res);
        assert.equal(res.code, 502);
        assert.equal(res.body.error, 'Rout answered 503 without JSON.');
        assert.equal(res.body.detail, '<html>maintenance</html>');
    });

    it('answers 504 on a timeout and 502 when Rout cannot be reached', async () => {
        secrets([secret('rout', 'rk-1')]);
        globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
        const slow = response();
        await (await routes())['POST /systemone'](request(ask), slow);
        assert.equal(slow.code, 504);
        assert.equal(slow.body.error, NO_ANSWER);
        globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
        const down = response();
        await (await routes())['POST /systemone'](request(ask), down);
        assert.equal(down.code, 502);
        assert.equal(down.body.error, 'fetch failed');
    });
});

describe('the strip routes', () => {
    it('keep the history of each chat under the folder of the requesting user', async () => {
        secrets([secret('rout', 'rk-1')]);
        answer(200, { answers: { echo: { score: 2.25 }, forme: { noul: 0.5 }, tone: { score: 'no' } } });
        const found = await routes();
        const asked = response();
        await found['POST /ask'](request({ chat: 'c1', latest: 'The door opens.', id: 4, user: 'Alice' }), asked);
        assert.equal(asked.code, 200);
        assert.equal(sent[0].body.state.latest_reply, 'The door opens.');
        assert.ok(!('tone' in sent[0].body.questions));
        assert.deepEqual(asked.body.hist.map(h => [h.id, h.s]), [[4, { echo: 2.25, forme: 0.5 }]]);

        const hist = response();
        await found['GET /hist']({ query: { chat: 'c1' }, user: { directories: { root } } }, hist);
        assert.deepEqual(hist.body.hist.map(h => h.id), [4]);

        const other = response();
        await found['GET /hist']({ query: { chat: 'c1' }, user: { directories: { root: join(root, 'other') } } }, other);
        assert.deepEqual(other.body.hist, []);
    });

    it('refuse a request without a chat, and /ask refuses without a key', async () => {
        const found = await routes();
        const hist = response();
        await found['GET /hist']({ query: {}, user: { directories: { root } } }, hist);
        assert.equal(hist.code, 400);
        const bare = response();
        await found['POST /ask'](request({ chat: 'c1' }), bare);
        assert.equal(bare.code, 400);
        const noKey = response();
        await found['POST /ask'](request({ chat: 'c1', latest: 'x' }), noKey);
        assert.equal(noKey.code, 401);
        assert.equal(noKey.body.error, NO_KEY);
    });
});
