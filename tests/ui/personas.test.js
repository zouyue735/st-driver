import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';
import { fixtureName } from '../helpers.js';

// Live integration tests for PersonaControl (frontend persona management).
// All fixtures use the __drvtest_ prefix and are deleted in after().
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 240_000;

let session, savedState, fixturePersonaName;

before(async () => {
    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
    savedState = await session.state.save();
    fixturePersonaName = fixtureName('persona');
});

after(async () => {
    try {
        // remove fixture personas created during the run
        const list = await session.personas.list().catch(() => []);
        for (const p of list) {
            if (p.name.startsWith('__drvtest_')) {
                await session.personas.delete(p.name, { silent: true }).catch(() => {});
            }
        }
        if (savedState) await session.state.restore(savedState);
    } finally {
        await session?.close();
    }
});

describe('PersonaControl', { timeout: TEST_TIMEOUT }, () => {
    test('list returns an array of personas with avatarKey/name fields', async () => {
        const list = await session.personas.list();
        assert.ok(Array.isArray(list));
        for (const p of list) {
            assert.equal(typeof p.avatarKey, 'string');
            assert.equal(typeof p.name, 'string');
        }
    });

    test('active reports the current persona (may be null)', async () => {
        const active = await session.personas.active();
        assert.ok('avatarKey' in active);
        assert.ok('name' in active);
    });

    test('create makes a new persona and returns its avatar key', async () => {
        const key = await session.personas.create({
            name: fixturePersonaName,
            description: 'driver test persona',
        });
        assert.ok(typeof key === 'string' && key.length > 0, `expected avatar key, got ${JSON.stringify(key)}`);
        const list = await session.personas.list();
        assert.ok(list.some(p => p.name === fixturePersonaName), 'created persona must appear in list');
    });

    test('get returns persona data as an object', async () => {
        const data = await session.personas.get({ persona: fixturePersonaName });
        assert.equal(typeof data, 'object');
        assert.ok(data, 'persona data must not be null');
    });

    test('get with field=name returns just the name', async () => {
        const name = await session.personas.get({ persona: fixturePersonaName, field: 'name' });
        assert.equal(name, fixturePersonaName);
    });

    test('update changes the persona description', async () => {
        const newDesc = `updated-${Date.now()}`;
        const r = await session.personas.update({ persona: fixturePersonaName, description: newDesc });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const desc = await session.personas.get({ persona: fixturePersonaName, field: 'description' });
        assert.equal(desc, newDesc);
    });

    test('set switches the active persona by name', async () => {
        const r = await session.personas.set(fixturePersonaName);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const active = await session.personas.active();
        assert.equal(active.name, fixturePersonaName);
    });

    test('duplicate copies the persona under a new name', async () => {
        const r = await session.personas.duplicate(fixturePersonaName);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const list = await session.personas.list();
        const dupes = list.filter(p => p.name.includes(fixturePersonaName.replace('__drvtest_', '')));
        assert.ok(dupes.length >= 2, `expected original + duplicate, got ${dupes.length}`);
    });

    test('lock type=chat on/off reports a lock state', async () => {
        const r = await session.personas.lock({ type: 'chat', on: true });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const off = await session.personas.lock({ type: 'chat', on: false });
        assert.equal(off.isError, false, off.errorMessage ?? '');
    });

    test('delete removes one persona by name (silent skips confirmation)', async () => {
        // NOTE: the duplicate test above created a persona with the SAME name
        // (ST duplicates keep the original name), so delete-by-name removes one
        // of them. Loop until none remain and assert each delete reports true.
        let list = await session.personas.list();
        let count = list.filter(p => p.name === fixturePersonaName).length;
        assert.ok(count >= 2, `expected original + duplicate, got ${count}`);
        while (count > 0) {
            const r = await session.personas.delete(fixturePersonaName, { silent: true });
            assert.equal(r.isError, false, r.errorMessage ?? '');
            assert.equal(r.pipe, 'true', 'delete must report success');
            list = await session.personas.list();
            const now = list.filter(p => p.name === fixturePersonaName).length;
            assert.equal(now, count - 1, 'exactly one persona must be removed per call');
            count = now;
        }
    });

    test('setDescriptionPlacement accepts position values', async () => {
        // create a temp persona to avoid touching the user's active one
        const tmp = fixtureName('placement');
        await session.personas.create({ name: tmp });
        const r = await session.personas.setDescriptionPlacement({ persona: tmp, position: 4, depth: 2, role: 'system' });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        await session.personas.delete(tmp, { silent: true });
    });
});
