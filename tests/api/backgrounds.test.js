/**
 * LIVE integration tests for BackgroundsApi (src/api/backgrounds.js).
 *
 * All fixture names use the __drvtest_ prefix and are cleaned up in after().
 *
 * Verified quirks (ST 1.18.0):
 * - /upload response is plain text (the sanitized filename), not JSON.
 * - /rename and /delete responses are plain text 'ok', not JSON.
 * - /rename with missing old_bg → 500 (not 400); /delete with missing bg → 500.
 * - /delete with '/' in bg → 400 (validateFileName middleware).
 * - /rename nonexistent or onto existing → 400.
 * - /delete nonexistent → 400.
 * - /upload with '/' in fileName → server sanitizes (strips slash), returns
 *   sanitized name; no 400.
 * - /all config is {width: 160, height: 90} (thumbnail dimensions from config).
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundsApi } from '../../src/api/backgrounds.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, tinyPng, purgeFixtures, FIXTURE_PREFIX } from '../helpers.js';

let client;
let api;
/** Track every uploaded bg filename so after() can delete them. */
const uploaded = [];

before(async () => {
    client = await newClient();
    api = new BackgroundsApi(client);
});

after(async () => {
    for (const bg of uploaded) {
        await api.delete(bg).catch(() => {});
    }
    await purgeFixtures(client);
    await client?.close();
});

/**
 * Upload a tinyPng fixture and track it for cleanup.
 * @param {string} [scope] fixture scope tag
 * @returns {Promise<string>} the sanitized filename returned by the server
 */
async function uploadFixture(scope = 'bg') {
    const name = `${fixtureName(scope)}.png`;
    const result = await api.upload(tinyPng(), name);
    uploaded.push(result);
    return result;
}

describe('BackgroundsApi.all() — POST /api/backgrounds/all', () => {
    test('returns {images: [{filename, isAnimated}], config: {width, height}}', async () => {
        const res = await api.all();
        assert.ok(Array.isArray(res.images), 'images must be an array');
        assert.equal(typeof res.config, 'object');
        assert.equal(typeof res.config.width, 'number');
        assert.equal(typeof res.config.height, 'number');
        if (res.images.length > 0) {
            assert.equal(typeof res.images[0].filename, 'string');
            assert.equal(typeof res.images[0].isAnimated, 'boolean');
        }
    });

    test('config.width and config.height match thumbnail bg dimensions (160x90)', async () => {
        const { config } = await api.all();
        assert.equal(config.width, 160);
        assert.equal(config.height, 90);
    });

    test('contains a freshly uploaded fixture', async () => {
        const bg = await uploadFixture('bg_all');
        const { images } = await api.all();
        const entry = images.find(i => i.filename === bg);
        assert.ok(entry, `fixture ${bg} must appear in all()`);
        assert.equal(entry.isAnimated, false, 'tinyPng is not animated');
    });
});

describe('BackgroundsApi.folders() — POST /api/backgrounds/folders', () => {
    test('returns {folders: array, imageFolderMap: object}', async () => {
        const res = await api.folders();
        assert.ok(Array.isArray(res.folders), 'folders must be an array');
        assert.equal(typeof res.imageFolderMap, 'object');
    });

    test('folders entries have {id, name, thumbnailFile} shape', async () => {
        const { folders } = await api.folders();
        for (const f of folders) {
            assert.equal(typeof f.id, 'string');
            assert.equal(typeof f.name, 'string');
            assert.equal(typeof f.thumbnailFile, 'string');
        }
    });
});

describe('BackgroundsApi.upload(buffer, fileName) — POST /api/backgrounds/upload (multipart)', () => {
    test('uploads a PNG and returns the sanitized filename as plain text', async () => {
        const name = `${fixtureName('bg_up')}.png`;
        const result = await api.upload(tinyPng(), name);
        uploaded.push(result);
        assert.equal(typeof result, 'string');
        assert.equal(result, name, 'server returns the sanitized original filename');
    });

    test('upload with no file throws StApiError 400', async () => {
        await assert.rejects(
            () => client.postForm('/api/backgrounds/upload', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('upload with "/" in fileName is sanitized by the server (slash stripped)', async () => {
        const name = `${fixtureName('bg_slash')}.png`;
        const result = await api.upload(tinyPng(), `bad/${name}`);
        uploaded.push(result);
        assert.equal(typeof result, 'string');
        assert.ok(!result.includes('/'), 'returned filename must not contain /');
        // The server strips the slash; verify the file is actually stored
        const { images } = await api.all();
        assert.ok(images.some(i => i.filename === result));
    });
});

describe('BackgroundsApi.rename({oldBg, newBg}) — POST /api/backgrounds/rename', () => {
    test('renames an existing background and returns plain text "ok"', async () => {
        const oldBg = await uploadFixture('bg_rn_old');
        const newBg = `${fixtureName('bg_rn_new')}.png`;
        const result = await api.rename({ oldBg, newBg });
        assert.equal(result, 'ok');
        // Track new name for cleanup; old name is already gone
        uploaded.push(newBg);
        const { images } = await api.all();
        assert.ok(images.some(i => i.filename === newBg), 'new name must be present');
        assert.ok(!images.some(i => i.filename === oldBg), 'old name must be gone');
    });

    test('rename nonexistent old_bg throws StApiError 400', async () => {
        await assert.rejects(
            () => api.rename({ oldBg: `__drvtest_nope_${Date.now()}.png`, newBg: 'x.png' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('rename onto an existing new_bg throws StApiError 400', async () => {
        const bg = await uploadFixture('bg_rn_clash');
        await assert.rejects(
            () => api.rename({ oldBg: bg, newBg: bg }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('rename with missing old_bg throws StApiError 500 (ST quirk: not 400)', async () => {
        await assert.rejects(
            () => client.postRaw('/api/backgrounds/rename', { new_bg: 'x.png' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackgroundsApi.delete(bg) — POST /api/backgrounds/delete', () => {
    test('deletes an existing background and returns plain text "ok"', async () => {
        const bg = await uploadFixture('bg_del');
        const result = await api.delete(bg);
        assert.equal(result, 'ok');
        // Remove from tracking since it's already deleted
        const idx = uploaded.indexOf(bg);
        if (idx !== -1) uploaded.splice(idx, 1);
        const { images } = await api.all();
        assert.ok(!images.some(i => i.filename === bg), 'deleted bg must be gone');
    });

    test('delete nonexistent bg throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete(`__drvtest_nope_${Date.now()}.png`),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete with "/" in bg throws StApiError 400 (validateFileName middleware)', async () => {
        await assert.rejects(
            () => api.delete('bad/name.png'),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete with missing bg field throws StApiError 500 (ST quirk: not 400)', async () => {
        await assert.rejects(
            () => client.postRaw('/api/backgrounds/delete', {}),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackgroundsApi full lifecycle', () => {
    test('upload → all contains → folders → rename → delete leaves no trace', async () => {
        const original = `${fixtureName('bg_life')}.png`;
        const renamed = `${fixtureName('bg_life2')}.png`;

        // upload
        const uploaded_name = await api.upload(tinyPng(), original);
        assert.equal(uploaded_name, original);

        // all contains
        const { images: imgs1 } = await api.all();
        assert.ok(imgs1.some(i => i.filename === original));

        // folders is callable (no fixture folder needed)
        const { folders, imageFolderMap } = await api.folders();
        assert.ok(Array.isArray(folders));
        assert.equal(typeof imageFolderMap, 'object');

        // rename
        const rnResult = await api.rename({ oldBg: original, newBg: renamed });
        assert.equal(rnResult, 'ok');
        const { images: imgs2 } = await api.all();
        assert.ok(imgs2.some(i => i.filename === renamed));
        assert.ok(!imgs2.some(i => i.filename === original));

        // delete
        const delResult = await api.delete(renamed);
        assert.equal(delResult, 'ok');
        const { images: imgs3 } = await api.all();
        assert.ok(!imgs3.some(i => i.filename === renamed));
        assert.ok(!imgs3.some(i => i.filename === original));
    });
});
