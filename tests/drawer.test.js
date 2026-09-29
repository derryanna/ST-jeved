import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { installDom, settle } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';

const body = installDom();
globalThis.document.getElementById = id => (id === 'extensions_settings2' ? body : null);
globalThis.IntersectionObserver = class { observe() {} };

hostStub();

const { HOSTS } = await import('../src/classifier.js');
const { getSettings, initSettings } = await import('../src/settings.js');
const { addDrawer } = await import('../src/ui/drawer.js');

const rout = HOSTS.find(host => host.keyless);
const title = () => body.querySelector('.jeved-first-title');
const keyField = () => body.querySelectorAll('.jeved-input').find(item => item.type === 'password') ?? null;

async function pick(endpoint) {
    const picker = body.querySelector('.jeved-picker');
    picker.value = endpoint;
    picker.fire('change');
    await settle();
}

describe('the first-run panel of the drawer', () => {
    before(async () => {
        initSettings();
        addDrawer();
        await settle();
    });

    it('asks for a host and a key while there is no key', () => {
        assert.equal(getSettings().apiKey, '');
        assert.equal(title().textContent, 'Pick a host and paste its API key to start.');
        assert.equal(keyField().hidden, false);
    });

    it('drops the key field and points at Test when the picked host keeps its key on the server', async () => {
        await pick(rout.endpoint);
        assert.equal(getSettings().endpoint, rout.endpoint);
        assert.equal(getSettings().model, rout.model);
        assert.equal(title().textContent, 'This host keeps its key on the server. Press Test to check the jev-sensors plugin.');
        assert.equal(keyField().hidden, true);
    });

    it('asks for the key again when a keyed host is picked back', async () => {
        await pick(HOSTS[0].endpoint);
        assert.equal(title().textContent, 'Pick a host and paste its API key to start.');
        assert.equal(keyField().hidden, false);
    });
});
