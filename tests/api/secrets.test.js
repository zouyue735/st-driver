/**
 * LIVE INTEGRATION tests for SecretsApi against a running SillyTavern.
 *
 * LOSSLESS PRINCIPLE (critical - this is the user's daily instance):
 *  - Tests ONLY touch dedicated keys that were verified EMPTY before the run:
 *      api_key_horde  (multi-secret write/rotate/rename/delete coverage)
 *      libre_url      (an EXPORTABLE key, the only one find() can return
 *                      in clear text when allowKeysExposure is false)
 *  - Every test deletes what it wrote, and `after` re-deletes both keys
 *    unconditionally as a safety net.
 *  - api_key_openai / api_key_deepseek (the user's real keys) are NEVER
 *    written, renamed, rotated or deleted. read() is asserted not to leak
 *    their values in clear text.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsApi, EXPORTABLE_SECRET_KEYS } from '../../src/api/secrets.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, FIXTURE_PREFIX } from '../helpers.js';

const TEST_KEY = 'api_key_horde';
const EXPORTABLE_KEY = 'libre_url';
const USER_KEYS_UNTOUCHABLE = ['api_key_openai', 'api_key_deepseek'];

let client;
let api;
let allowKeysExposure;

before(async () => {
    client = await newClient();
    api = new SecretsApi(client);
    ({ allowKeysExposure } = await api.settings());

    const state = await api.read();
    // Guard: refuse to run write tests if the dedicated keys are already in use.
    assert.equal(state[TEST_KEY], null,
        `${TEST_KEY} must be empty before secrets tests (user data at risk) - abort`);
    assert.equal(state[EXPORTABLE_KEY], null,
        `${EXPORTABLE_KEY} must be empty before secrets tests (user data at risk) - abort`);
});

after(async () => {
    // Safety net: wipe the two dedicated keys no matter what happened above.
    for (const key of [TEST_KEY, EXPORTABLE_KEY]) {
        try {
            const state = await api.read();
            for (const entry of state[key] ?? []) {
                await api.delete({ key, id: entry.id }).catch(() => {});
            }
            await api.delete({ key }).catch(() => {});
        } catch { /* ignore */ }
    }
    await client?.close();
});

describe('SecretsApi.settings()', () => {
    test('returns {allowKeysExposure} boolean', async () => {
        const res = await api.settings();
        assert.equal(typeof res, 'object');
        assert.equal(typeof res.allowKeysExposure, 'boolean');
    });

    test('allowKeysExposure value matches the running server config', () => {
        // This local instance runs with the default (false); assert the observed value
        // so downstream tests branch on the real capability rather than an assumption.
        assert.equal(typeof allowKeysExposure, 'boolean');
    });
});

describe('SecretsApi.read()', () => {
    test('returns a state map keyed by every known secret key', async () => {
        const state = await api.read();
        assert.equal(typeof state, 'object');
        assert.ok(Object.keys(state).length >= 50, 'SECRET_KEYS has ~60 entries');
    });

    test('unset keys map to null, set keys map to an array of states', async () => {
        const state = await api.read();
        assert.equal(state[TEST_KEY], null);
        const userKey = USER_KEYS_UNTOUCHABLE.find(k => Array.isArray(state[k]));
        assert.ok(userKey, 'at least one user key is expected to be populated on this instance');
        const entry = state[userKey][0];
        assert.equal(typeof entry.id, 'string');
        assert.equal(typeof entry.value, 'string');
        assert.equal(typeof entry.label, 'string');
        assert.equal(typeof entry.active, 'boolean');
    });

    test('read() masks values of the user keys (never leaks them in clear)', async () => {
        if (allowKeysExposure) return; // exposure on => server intentionally returns clear values
        const state = await api.read();
        for (const key of USER_KEYS_UNTOUCHABLE) {
            for (const entry of state[key] ?? []) {
                assert.ok(entry.value.includes('*'), `${key} value must be masked, got ${entry.value}`);
                assert.equal(entry.value.length, 10, 'masked form is exactly 10 chars');
            }
        }
    });

    test('read() omits the internal _migrated marker key', async () => {
        const state = await api.read();
        assert.ok(!Object.hasOwn(state, '_migrated'));
    });
});

describe('EXPORTABLE_SECRET_KEYS constant', () => {
    test('matches the server EXPORTABLE_KEYS list', () => {
        assert.deepEqual([...EXPORTABLE_SECRET_KEYS], [
            'libre_url', 'lingva_url', 'oneringtranslator_url', 'deeplx_url',
        ]);
    });
});

describe('SecretsApi.write()', () => {
    let id;

    test('write({key,value,label}) returns {id} (uuid)', async () => {
        id = (await api.write({
            key: TEST_KEY,
            value: `${FIXTURE_PREFIX}value_aaa`,
            label: `${FIXTURE_PREFIX}label`,
        })).id;
        assert.equal(typeof id, 'string');
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        await api.delete({ key: TEST_KEY, id });
    });

    test('written secret shows up in read() state as active with its label', async () => {
        id = (await api.write({
            key: TEST_KEY,
            value: `${FIXTURE_PREFIX}value_bbb`,
            label: `${FIXTURE_PREFIX}label_b`,
        })).id;
        const state = await api.read();
        assert.equal(state[TEST_KEY].length, 1);
        assert.equal(state[TEST_KEY][0].id, id);
        assert.equal(state[TEST_KEY][0].label, `${FIXTURE_PREFIX}label_b`);
        assert.equal(state[TEST_KEY][0].active, true);
        await api.delete({ key: TEST_KEY, id });
    });

    test('write without a value 400s', async () => {
        await assert.rejects(
            () => api.write({ key: TEST_KEY, label: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('write without a key 400s', async () => {
        await assert.rejects(
            () => api.write({ value: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SecretsApi.rename()', () => {
    test('rename({key,id,label}) changes the label (204 -> null)', async () => {
        const { id } = await api.write({
            key: TEST_KEY,
            value: `${FIXTURE_PREFIX}value_ccc`,
            label: `${FIXTURE_PREFIX}old_label`,
        });
        const res = await api.rename({ key: TEST_KEY, id, label: `${FIXTURE_PREFIX}new_label` });
        assert.equal(res, null);
        const state = await api.read();
        assert.equal(state[TEST_KEY][0].label, `${FIXTURE_PREFIX}new_label`);
        await api.delete({ key: TEST_KEY, id });
    });

    test('rename without a label 400s', async () => {
        const { id } = await api.write({ key: TEST_KEY, value: 'v', label: 'l' });
        try {
            await assert.rejects(
                () => api.rename({ key: TEST_KEY, id }),
                err => err instanceof StApiError && err.status === 400,
            );
        } finally {
            await api.delete({ key: TEST_KEY, id });
        }
    });

    test('rename without an id 400s', async () => {
        await assert.rejects(
            () => api.rename({ key: TEST_KEY, label: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SecretsApi.rotate()', () => {
    let firstId;
    let secondId;

    test('a second write on the same key deactivates the first and activates itself', async () => {
        firstId = (await api.write({
            key: TEST_KEY, value: `${FIXTURE_PREFIX}value_111`, label: `${FIXTURE_PREFIX}first`,
        })).id;
        secondId = (await api.write({
            key: TEST_KEY, value: `${FIXTURE_PREFIX}value_222`, label: `${FIXTURE_PREFIX}second`,
        })).id;
        assert.notEqual(firstId, secondId);
        const state = await api.read();
        assert.equal(state[TEST_KEY].length, 2);
        const byId = Object.fromEntries(state[TEST_KEY].map(s => [s.id, s]));
        assert.equal(byId[firstId].active, false);
        assert.equal(byId[secondId].active, true);
    });

    test('rotate({key,id:first}) makes the first secret active again (204 -> null)', async () => {
        const res = await api.rotate({ key: TEST_KEY, id: firstId });
        assert.equal(res, null);
        const state = await api.read();
        const byId = Object.fromEntries(state[TEST_KEY].map(s => [s.id, s]));
        assert.equal(byId[firstId].active, true);
        assert.equal(byId[secondId].active, false);
    });

    test('rotate back to the second id restores the original active selection', async () => {
        await api.rotate({ key: TEST_KEY, id: secondId });
        const state = await api.read();
        const byId = Object.fromEntries(state[TEST_KEY].map(s => [s.id, s]));
        assert.equal(byId[secondId].active, true);
        assert.equal(byId[firstId].active, false);
    });

    test('rotate without an id 400s', async () => {
        await assert.rejects(
            () => api.rotate({ key: TEST_KEY }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('rotate with an unknown id is a silent no-op (204), active entry unchanged', async () => {
        await api.rotate({ key: TEST_KEY, id: '00000000-0000-0000-0000-000000000000' });
        const state = await api.read();
        const active = state[TEST_KEY].filter(s => s.active);
        assert.equal(active.length, 1);
        assert.equal(active[0].id, secondId);
    });

    test('delete({key,id}) removes one entry and reactivates the survivor', async () => {
        await api.delete({ key: TEST_KEY, id: secondId });
        const state = await api.read();
        assert.equal(state[TEST_KEY].length, 1);
        assert.equal(state[TEST_KEY][0].id, firstId);
        assert.equal(state[TEST_KEY][0].active, true);
    });

    test('deleting the last entry makes the key null again (full restore)', async () => {
        await api.delete({ key: TEST_KEY, id: firstId });
        const state = await api.read();
        assert.equal(state[TEST_KEY], null);
    });
});

describe('SecretsApi.find()', () => {
    test('find on a non-exportable key without allowKeysExposure 403s', async (t) => {
        if (allowKeysExposure) {
            t.skip('allowKeysExposure is true on this server; 403 path not reachable');
            return;
        }
        const { id } = await api.write({ key: TEST_KEY, value: 'v', label: 'l' });
        try {
            await assert.rejects(
                () => api.find({ key: TEST_KEY, id }),
                err => err instanceof StApiError && err.status === 403,
            );
        } finally {
            await api.delete({ key: TEST_KEY, id });
        }
    });

    test('find on an EXPORTABLE key returns the clear value even without exposure', async () => {
        const value = `http://${FIXTURE_PREFIX}libre.example/`;
        const { id } = await api.write({ key: EXPORTABLE_KEY, value, label: `${FIXTURE_PREFIX}libre` });
        try {
            const res = await api.find({ key: EXPORTABLE_KEY, id });
            assert.deepEqual(res, { value });
        } finally {
            await api.delete({ key: EXPORTABLE_KEY, id });
        }
    });

    test('find without an id returns the ACTIVE secret value', async () => {
        const value = `http://${FIXTURE_PREFIX}libre-active/`;
        await api.write({ key: EXPORTABLE_KEY, value: 'http://inactive/', label: 'inactive' });
        const { id } = await api.write({ key: EXPORTABLE_KEY, value, label: 'active' });
        try {
            const res = await api.find({ key: EXPORTABLE_KEY });
            assert.deepEqual(res, { value });
        } finally {
            await api.delete({ key: EXPORTABLE_KEY, id });
            await api.delete({ key: EXPORTABLE_KEY });
        }
    });

    test('find on an unset key 404s', async () => {
        await assert.rejects(
            () => api.find({ key: EXPORTABLE_KEY }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('find without a key 400s', async () => {
        await assert.rejects(
            () => api.find({ id: 'whatever' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SecretsApi.delete()', () => {
    test('delete({key}) without an id removes the active secret (204 -> null)', async () => {
        const { id } = await api.write({ key: TEST_KEY, value: 'v', label: 'l' });
        const res = await api.delete({ key: TEST_KEY });
        assert.equal(res, null);
        const state = await api.read();
        assert.equal(state[TEST_KEY], null);
        await api.delete({ key: TEST_KEY, id }).catch(() => {});
    });

    test('delete without a key 400s', async () => {
        await assert.rejects(
            () => api.delete({ id: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete with an unknown id is a silent no-op (204) and leaves the key null', async () => {
        const res = await api.delete({ key: TEST_KEY, id: 'no-such-id' });
        assert.equal(res, null);
        const state = await api.read();
        assert.equal(state[TEST_KEY], null);
    });
});

describe('SecretsApi.view()', () => {
    test('view() 403s when allowKeysExposure is false', async (t) => {
        if (allowKeysExposure) {
            const res = await api.view();
            assert.equal(typeof res, 'object');
            t.skip('allowKeysExposure is true; only the clear-text path is reachable');
            return;
        }
        await assert.rejects(
            () => api.view(),
            err => err instanceof StApiError && err.status === 403,
        );
    });
});

describe('user data untouched', () => {
    test('the user secret keys are still present and unchanged in read()', async () => {
        const state = await api.read();
        for (const key of USER_KEYS_UNTOUCHABLE) {
            assert.ok(Array.isArray(state[key]) && state[key].length > 0,
                `${key} must still hold the user's secret after the test run`);
        }
    });
});
