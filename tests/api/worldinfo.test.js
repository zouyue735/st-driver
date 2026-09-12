/**
 * Live integration tests for src/api/worldinfo.js (WorldInfoApi).
 *
 * Verified against ST 1.18.0 handlers: src/endpoints/worldinfo.js
 *
 * Notes on observed server behaviour:
 * - POST /api/worldinfo/get on a NON-EXISTENT world returns a dummy
 *   { entries: {} } object with status 200 (readWorldInfoFile allowDummy=true),
 *   not an error.
 * - POST /api/worldinfo/edit writes <name>.json unconditionally, so calling
 *   edit() with a fresh name CREATES the world (no import needed). The body
 *   envelope is { name, data } where data must contain an `entries` key.
 * - POST /api/worldinfo/import requires a multipart file (field name
 *   `avatar` via the global multer mount) even when the convertedData body
 *   field carries the actual JSON; the world name is derived from the
 *   uploaded file's original name. Response: { name }.
 * - POST /api/worldinfo/delete on a missing file throws inside the handler
 *   -> HTTP 500.
 * - /api/worldinfo/edit performs NO normalization of entry fields: entries
 *   round-trip byte-for-byte through the JSON file.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorldInfoApi } from '../../src/api/worldinfo.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, purgeFixtures } from '../helpers.js';

let client;
let api;
/** World names created during the run - deleted in after() as cleanup. */
const createdWorlds = new Set();

/** Create a world via edit() and register it for cleanup. */
async function createWorld(name = fixtureName('world'), data = { entries: {} }) {
    await api.edit(name, data);
    createdWorlds.add(name);
    return name;
}

before(async () => {
    client = await newClient();
    api = new WorldInfoApi(client);
});

after(async () => {
    for (const name of createdWorlds) {
        await api.delete(name).catch(() => {});
    }
    await purgeFixtures(client).catch(() => {});
    await client?.close();
});

describe('WorldInfoApi construction', () => {
    test('stores the provided client', () => {
        const a = new WorldInfoApi(client);
        assert.equal(a.client, client);
    });
});

describe('list()', () => {
    test('returns an array', async () => {
        const worlds = await api.list();
        assert.ok(Array.isArray(worlds));
    });

    test('a created world is listed with file_id, name and extensions', async () => {
        const name = await createWorld();
        const worlds = await api.list();
        const found = worlds.find(w => w.file_id === name);
        assert.ok(found, 'world must appear in list()');
        assert.ok('name' in found);
        assert.ok('extensions' in found);
        assert.equal(typeof found.extensions, 'object');
    });

    test('the name field falls back to the file id when the data has no name key', async () => {
        const name = await createWorld(fixtureName('wname'), { entries: {} });
        const worlds = await api.list();
        const found = worlds.find(w => w.file_id === name);
        assert.equal(found.name, name, 'observed: name = contents.name || filename');
    });

    test('the name field comes from the data object when present', async () => {
        const fileId = await createWorld();
        await api.edit(fileId, { name: `${fileId}_display`, entries: {} });
        const worlds = await api.list();
        const found = worlds.find(w => w.file_id === fileId);
        assert.equal(found.name, `${fileId}_display`);
    });
});

describe('get()', () => {
    test('returns { entries } for an existing world', async () => {
        const name = await createWorld(fixtureName('wget'), { entries: { '0': { uid: '0', key: ['k'], content: 'c' } } });
        const world = await api.get(name);
        assert.equal(typeof world.entries, 'object');
        assert.equal(world.entries['0'].content, 'c');
    });

    test('returns the dummy { entries: {} } for a NON-EXISTENT world (observed: 200, not an error)', async () => {
        const world = await api.get('__drvtest_definitely_missing_world__');
        assert.deepEqual(world, { entries: {} });
    });

    test('without name throws StApiError 400', async () => {
        await assert.rejects(
            () => api.get(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('edit()', () => {
    test('returns { ok: true }', async () => {
        const name = await createWorld();
        const res = await api.edit(name, { entries: {} });
        assert.deepEqual(res, { ok: true });
    });

    test('creates a world that does not exist yet (source: edit writes unconditionally)', async () => {
        const name = fixtureName('wcreated');
        const res = await api.edit(name, { entries: {} });
        createdWorlds.add(name);
        assert.deepEqual(res, { ok: true });
        const worlds = await api.list();
        assert.ok(worlds.some(w => w.file_id === name));
    });

    test('overwrites the whole world object', async () => {
        const name = await createWorld(fixtureName('wovr'), { entries: { '0': { uid: '0', content: 'old' } } });
        await api.edit(name, { entries: { '5': { uid: '5', content: 'new' } } });
        const world = await api.get(name);
        assert.deepEqual(Object.keys(world.entries), ['5']);
        assert.equal(world.entries['5'].content, 'new');
    });

    test('persists extra top-level keys of the data object', async () => {
        const name = await createWorld();
        await api.edit(name, { name: 'x', entries: {}, customTopKey: 123 });
        const world = await api.get(name);
        assert.equal(world.customTopKey, 123);
    });

    test('without name throws StApiError 400', async () => {
        await assert.rejects(
            () => api.edit(undefined, { entries: {} }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('data without an entries key throws StApiError 400', async () => {
        await assert.rejects(
            () => api.edit(fixtureName('wnoentries'), { nope: true }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('delete()', () => {
    test('removes the world from list()', async () => {
        const name = await createWorld();
        await api.delete(name);
        createdWorlds.delete(name);
        const worlds = await api.list();
        assert.equal(worlds.some(w => w.file_id === name), false);
    });

    test('of a non-existent world throws StApiError 500 (observed: handler throws)', async () => {
        await assert.rejects(
            () => api.delete('__drvtest_definitely_missing_world__'),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('without name throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('import()', () => {
    test('imports a world book JSON via multipart file and returns { name }', async () => {
        const name = fixtureName('wimp');
        const book = JSON.stringify({ entries: { '0': { uid: '0', key: ['imported'], content: 'via file' } } });
        const res = await api.import(Buffer.from(book, 'utf8'), { name });
        createdWorlds.add(res.name);
        assert.deepEqual(res, { name });
        const world = await api.get(name);
        assert.equal(world.entries['0'].content, 'via file');
    });

    test('accepts a data object instead of a buffer', async () => {
        const name = fixtureName('wimpobj');
        const res = await api.import({ entries: { '0': { uid: '0', content: 'via object' } } }, { name });
        createdWorlds.add(res.name);
        assert.deepEqual(res, { name });
        assert.equal((await api.get(name)).entries['0'].content, 'via object');
    });

    test('honours the convertedData body field (file present but contents taken from the field)', async () => {
        const name = fixtureName('wimpconv');
        // Source: if request.body.convertedData exists it wins over the file bytes.
        const fileBytes = JSON.stringify({ entries: { '0': { uid: '0', content: 'from file' } } });
        const converted = JSON.stringify({ entries: { '0': { uid: '0', content: 'from convertedData' } } });
        const res = await api.import(Buffer.from(fileBytes, 'utf8'), { name, convertedData: converted });
        createdWorlds.add(res.name);
        assert.equal((await api.get(name)).entries['0'].content, 'from convertedData');
    });

    test('rejects JSON without an entries key with StApiError 400', async () => {
        await assert.rejects(
            () => api.import(Buffer.from(JSON.stringify({ nope: true }), 'utf8'), { name: fixtureName('wimpbad') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('without name throws (client-side guard, no request sent)', async () => {
        await assert.rejects(
            () => api.import(Buffer.from('{}'), {}),
            /name/i,
        );
    });
});

describe('entry full-field round-trip', () => {
    test('every documented ST entry field survives edit -> get', async () => {
        const name = await createWorld(fixtureName('wfull'));
        const entry = {
            uid: '0',
            key: ['alpha', 'beta'],
            keysecondary: ['gamma'],
            comment: 'full field entry',
            content: 'the actual lore text',
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 2,
            addMemo: 'a memo',
            order: 7,
            position: 4,
            disable: false,
            ignoreBudget: true,
            excludeRecursion: true,
            preventRecursion: false,
            delayUntilRecursion: true,
            matchPersonaDescription: true,
            matchCharacterDescription: false,
            matchCharacterPersonality: true,
            matchCharacterDepthPrompt: false,
            matchScenario: true,
            matchCreatorNotes: false,
            probability: 75,
            useProbability: true,
            depth: 3,
            outletName: 'my-outlet',
            group: 'grp',
            groupOverride: true,
            groupWeight: 50,
            scanDepth: 4,
            caseSensitive: true,
            matchWholeWords: false,
            useGroupScoring: true,
            automationId: 'auto-1',
            role: 2,
            sticky: 6,
            cooldown: 12,
            delay: 24,
            characterFilterNames: ['Alice', 'Bob'],
            characterFilterTags: ['tag1'],
            characterFilterExclude: true,
            triggers: [['t1', 't2'], ['t3']],
        };
        await api.edit(name, { entries: { '0': entry } });
        const world = await api.get(name);
        const back = world.entries['0'];
        // Per-field assertions (independent failure messages for each field).
        for (const [field, expected] of Object.entries(entry)) {
            assert.deepEqual(back[field], expected, `entry field "${field}" must round-trip`);
        }
        // And no field was silently dropped.
        assert.deepEqual(Object.keys(back).sort(), Object.keys(entry).sort());
    });

    test('numeric enum fields keep their values (position, selectiveLogic, role)', async () => {
        const name = await createWorld(fixtureName('wenum'));
        const positions = [0, 1, 2, 3, 4, 5, 6, 7];
        const entries = {};
        positions.forEach((p, i) => {
            entries[String(i)] = { uid: String(i), position: p, selectiveLogic: i % 4, role: i % 3 };
        });
        await api.edit(name, { entries });
        const back = (await api.get(name)).entries;
        for (let i = 0; i < positions.length; i++) {
            assert.equal(back[String(i)].position, positions[i]);
            assert.equal(back[String(i)].selectiveLogic, i % 4);
            assert.equal(back[String(i)].role, i % 3);
        }
    });

    test('multiple entries with string uids round-trip', async () => {
        const name = await createWorld(fixtureName('wmulti'));
        const entries = {
            'a-1': { uid: 'a-1', key: ['one'], content: 'first' },
            'b-2': { uid: 'b-2', key: ['two'], content: 'second' },
        };
        await api.edit(name, { entries });
        const back = (await api.get(name)).entries;
        assert.deepEqual(Object.keys(back).sort(), ['a-1', 'b-2']);
        assert.equal(back['b-2'].content, 'second');
    });
});
