import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStDriver, createUiDriver, STClient, StApiError, UiSession } from '../../src/index.js';

// Live tests for the driver entry points (src/index.js).
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';

let driver;

after(async () => {
    await driver?.close();
});

describe('createStDriver', () => {
    test('connects and exposes client + api + loadApi + loadAll', async () => {
        driver = await createStDriver({ baseUrl: BASE_URL });
        assert.ok(driver.client instanceof STClient);
        assert.ok(driver.client.csrfToken, 'client must be connected');
        assert.equal(typeof driver.loadApi, 'function');
        assert.equal(typeof driver.loadAll, 'function');
        assert.equal(typeof driver.api, 'object');
    });

    test('loadApi instantiates a module class bound to the client', async () => {
        const groups = await driver.loadApi('groups');
        assert.equal(groups.constructor.name, 'GroupsApi');
        const all = await groups.all();
        assert.ok(Array.isArray(all));
    });

    test('loadApi caches instances (same object on second call)', async () => {
        const a = await driver.loadApi('worldinfo');
        const b = await driver.loadApi('worldinfo');
        assert.equal(a, b);
    });

    test('loadApi rejects an unknown module name with the known list', async () => {
        await assert.rejects(() => driver.loadApi('not_a_module'), /unknown api module.*known:/);
    });

    test('loadAll reports loaded and missing modules without throwing', async () => {
        const { loaded, missing } = await driver.loadAll();
        assert.ok(loaded.includes('groups'), 'groups must load');
        assert.ok(loaded.includes('settings'), 'settings must load');
        // no overlap between loaded and missing
        assert.equal(loaded.filter(n => missing.includes(n)).length, 0);
        for (const name of loaded) {
            assert.ok(driver.api[name], `loaded module ${name} must be on api`);
        }
    });

    test('loaded modules work end-to-end (settings round trip)', async () => {
        const settings = await driver.loadApi('settings');
        const parsed = await settings.getSettings();
        assert.equal(typeof parsed, 'object');
        assert.ok('power_user' in parsed || 'oai_settings' in parsed);
    });

    test('client errors surface as StApiError through the facade', async () => {
        await assert.rejects(
            () => driver.client.post('/api/no-such-endpoint', {}),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('createUiDriver', () => {
    test('launches a UiSession and closes cleanly', async () => {
        const ui = await createUiDriver({ baseUrl: BASE_URL, headless: true, timeout: 120_000 });
        try {
            assert.ok(ui.session instanceof UiSession);
            const ok = await ui.session.evaluate(() => typeof SillyTavern?.getContext === 'function');
            assert.equal(ok, true);
        } finally {
            await ui.close();
        }
    });
});
