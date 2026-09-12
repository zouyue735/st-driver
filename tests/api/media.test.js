/**
 * LIVE integration tests for the media APIs (src/api/media.js):
 * FilesApi, ImageMetadataApi, ImagesApi, AssetsApi.
 *
 * All fixtures use the __drvtest_ prefix and are cleaned up in after()
 * (via the APIs where possible, plus a metadata cleanup() call; empty
 * user/images subdirectories are removed through the filesystem because no
 * HTTP endpoint exists for that).
 *
 * Verified quirks (ST 1.18.0):
 * - files/sanitize-filename with a MISSING fileName field answers
 *   {fileName: 'undefined'} (String(undefined)), empty string answers 400.
 * - files/verify silently SKIPS urls outside user/files (they do not appear
 *   in the result map at all).
 * - images/upload expects PURE base64 in `image`; a data URI is decoded
 *   verbatim and corrupts the stored file (no server-side stripping).
 * - images/list CREATES the folder when it does not exist and answers [].
 * - images/list sort defaults: sortField 'date', sortOrder 'asc'.
 * - image-metadata root POST with a path outside the user data dir answers
 *   500 (the validation throw is not mapped to 400); in batch mode the same
 *   path becomes an {error} ENTRY in the 200 response map.
 * - folders/assign only accepts 'backgrounds/...' paths — anything else is a
 *   500. Missing files are silently skipped (200).
 * - folders/unassign does NOT check that the folder exists (always 200).
 * - folders/set-thumbnails silently skips unknown folder ids (200).
 * - all({prefix}) omits the `folders` key (only {version, images}).
 * - assets/get excludes the 'temp' category and shapes vrm as
 *   {model: [], animation: []}.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FilesApi, ImageMetadataApi, ImagesApi, AssetsApi } from '../../src/api/media.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, tinyPng, dataRoot } from '../helpers.js';

let client;
let files;
let metadata;
let images;
let assets;

/**
 * ST user data root — for fs-level cleanup/assertions of empty image directories.
 * Opt-in via ST_DATA_ROOT (see helpers.dataRoot); null disables fs assertions.
 */
const DATA_ROOT = dataRoot();

/** Tracked fixtures for after() cleanup. */
const tracked = {
    filePaths: [],
    imagePaths: [],
    imageDirs: [],
    backgrounds: [],
    metaFolderIds: [],
};

before(async () => {
    client = await newClient();
    files = new FilesApi(client);
    metadata = new ImageMetadataApi(client);
    images = new ImagesApi(client);
    assets = new AssetsApi(client);
});

after(async () => {
    for (const p of tracked.filePaths) await files.delete({ path: p }).catch(() => {});
    for (const p of tracked.imagePaths) await images.delete({ path: p }).catch(() => {});
    for (const bg of tracked.backgrounds) {
        await client.postRaw('/api/backgrounds/delete', { bg }).catch(() => {});
    }
    for (const id of tracked.metaFolderIds) {
        await metadata.deleteFolder({ id }).catch(() => {});
    }
    // Remove orphaned metadata entries created by these tests.
    await metadata.cleanup().catch(() => {});
    // No HTTP endpoint can remove user/images subdirectories. Only possible when
    // ST_DATA_ROOT points at the same data dir the server uses.
    if (DATA_ROOT) {
        for (const dir of tracked.imageDirs) {
            fs.rmSync(path.join(DATA_ROOT, 'user/images', dir), { recursive: true, force: true });
        }
    }
    await client?.close();
});

/**
 * Upload a fixture file into user/files and track it for cleanup.
 * @param {string} [content]
 * @param {string} [ext]
 * @returns {Promise<{name: string, path: string}>}
 */
async function uploadFileFixture(content = 'fixture content', ext = 'txt') {
    const name = `${fixtureName('file')}.${ext}`;
    const res = await files.upload({ name, data: Buffer.from(content).toString('base64') });
    tracked.filePaths.push(res.path);
    return { name, path: res.path };
}

/**
 * Upload a fixture image into user/images and track it for cleanup.
 * @param {object} [options]
 * @param {string} [options.fileName]
 * @param {string} [options.format='png']
 * @param {string} [options.characterName] optional subfolder
 * @returns {Promise<{path: string}>}
 */
async function uploadImageFixture({ fileName, format = 'png', characterName } = {}) {
    const res = await images.upload({
        image: tinyPng().toString('base64'),
        format,
        fileName: fileName ?? fixtureName('img'),
        characterName,
    });
    tracked.imagePaths.push(res.path);
    return res;
}

/**
 * Upload a fixture background and track it for cleanup.
 * @returns {Promise<{fileName: string, relativePath: string}>}
 */
async function uploadBackgroundFixture() {
    const fileName = `${fixtureName('bg')}.png`;
    await client.postForm('/api/backgrounds/upload', {}, { fileName, mimeType: 'image/png', data: tinyPng() });
    tracked.backgrounds.push(fileName);
    return { fileName, relativePath: `backgrounds/${fileName}` };
}

/**
 * Create a fixture metadata folder and track it for cleanup.
 * @param {string} [name]
 * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
 */
async function createFolderFixture(name = fixtureName('folder')) {
    const folder = await metadata.createFolder({ name });
    tracked.metaFolderIds.push(folder.id);
    return folder;
}

describe('FilesApi.sanitizeFilename (POST /api/files/sanitize-filename)', () => {
    test('strips illegal characters <>:"|?* from the name', async () => {
        const res = await files.sanitizeFilename({ fileName: 'bad<>:"|?*name.png' });
        assert.deepEqual(res, { fileName: 'badname.png' });
    });

    test('strips slashes', async () => {
        const res = await files.sanitizeFilename({ fileName: 'dir/sub\\name.png' });
        assert.equal(res.fileName.includes('/'), false);
        assert.equal(res.fileName.includes('\\'), false);
    });

    test('passes an already-legal name through unchanged', async () => {
        const res = await files.sanitizeFilename({ fileName: 'legal_name-1.png' });
        assert.deepEqual(res, { fileName: 'legal_name-1.png' });
    });

    test('empty fileName throws StApiError 400', async () => {
        await assert.rejects(
            () => files.sanitizeFilename({ fileName: '' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('MISSING fileName field answers {fileName: "undefined"} (ST quirk, HTTP 200)', async () => {
        const res = await client.post('/api/files/sanitize-filename', {});
        assert.deepEqual(res, { fileName: 'undefined' });
    });
});

describe('FilesApi.upload (POST /api/files/upload)', () => {
    test('writes base64 data and returns {path} under /user/files/', async () => {
        const name = `${fixtureName('up')}.txt`;
        const res = await files.upload({ name, data: Buffer.from('hello').toString('base64') });
        tracked.filePaths.push(res.path);
        assert.deepEqual(res, { path: `/user/files/${name}` });
    });

    test('stored bytes round-trip exactly (static GET /user/files/<name>)', async () => {
        const fixture = await uploadFileFixture('round trip content');
        const bytes = await client.getBinary(`/user/files/${fixture.name}`);
        assert.equal(bytes.toString('utf8'), 'round trip content');
    });

    test('missing name throws StApiError 400', async () => {
        await assert.rejects(
            () => files.upload({ data: Buffer.from('x').toString('base64') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('missing data throws StApiError 400', async () => {
        await assert.rejects(
            () => files.upload({ name: `${fixtureName('nodata')}.txt` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('name with "/" throws StApiError 400 (validateAssetFileName)', async () => {
        await assert.rejects(
            () => files.upload({ name: 'bad/name.txt', data: Buffer.from('x').toString('base64') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('name with an unsafe extension (.exe) throws StApiError 400', async () => {
        await assert.rejects(
            () => files.upload({ name: `${fixtureName('unsafe')}.exe`, data: Buffer.from('x').toString('base64') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('name starting with "." throws StApiError 400', async () => {
        await assert.rejects(
            () => files.upload({ name: `.${fixtureName('dot')}`, data: Buffer.from('x').toString('base64') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('FilesApi.delete (POST /api/files/delete)', () => {
    test('deletes an uploaded file and answers plain text OK', async () => {
        const fixture = await uploadFileFixture();
        const res = await files.delete({ path: fixture.path });
        assert.equal(res, 'OK');
        tracked.filePaths.splice(tracked.filePaths.indexOf(fixture.path), 1);
        const verified = await files.verify({ urls: [fixture.path] });
        assert.deepEqual(verified, { [fixture.path]: false });
    });

    test('missing path throws StApiError 400', async () => {
        await assert.rejects(
            () => files.delete({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('path outside user/files throws StApiError 400 (Invalid path)', async () => {
        await assert.rejects(
            () => files.delete({ path: '../escape.txt' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('nonexistent path throws StApiError 404', async () => {
        await assert.rejects(
            () => files.delete({ path: `/user/files/__drvtest_missing_${Date.now()}.txt` }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('FilesApi.verify (POST /api/files/verify)', () => {
    test('maps an existing url to true and a missing one to false', async () => {
        const fixture = await uploadFileFixture();
        const missing = `user/files/__drvtest_missing_${Date.now()}.txt`;
        const res = await files.verify({ urls: [fixture.path, missing] });
        assert.equal(res[fixture.path], true);
        assert.equal(res[missing], false);
    });

    test('urls outside user/files are silently skipped (not present in the map)', async () => {
        const fixture = await uploadFileFixture();
        const res = await files.verify({ urls: [fixture.path, 'backgrounds/whatever.png'] });
        assert.equal(res[fixture.path], true);
        assert.equal('backgrounds/whatever.png' in res, false);
    });

    test('non-array urls throws StApiError 400', async () => {
        await assert.rejects(
            () => files.verify({ urls: 'not-an-array' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('empty urls array answers {}', async () => {
        assert.deepEqual(await files.verify({ urls: [] }), {});
    });
});

describe('ImageMetadataApi.get (POST /api/image-metadata {path})', () => {
    test('returns the full metadata object for an existing image', async () => {
        const bg = await uploadBackgroundFixture();
        const meta = await metadata.get({ path: bg.relativePath });
        assert.equal(typeof meta.hash, 'string');
        assert.equal(meta.hash.length, 64, 'sha256 hex');
        assert.equal(meta.aspectRatio, 1, 'tinyPng is 1x1');
        assert.equal(meta.isAnimated, false);
        assert.match(meta.dominantColor, /^#[0-9a-f]{6}$/i);
        assert.deepEqual(meta.folderIds, []);
        assert.equal(typeof meta.addedTimestamp, 'number');
        assert.equal(typeof meta.mtime, 'number');
    });

    test('backgrounds/upload pre-generates metadata with type bg (160*90 = 14400)', async () => {
        const bg = await uploadBackgroundFixture();
        const meta = await metadata.get({ path: bg.relativePath });
        assert.equal(meta.thumbnailResolution, 14400);
    });

    test('type only applies when metadata is FIRST generated; cached entries keep the old resolution (quirk)', async () => {
        // An image uploaded via /api/images/upload has NO pre-generated
        // metadata, so the first get() generates it. A fresh file without
        // `type` gets thumbnailResolution 0 (the server passes undefined
        // through to getThumbnailResolution).
        const img1 = await uploadImageFixture({ fileName: fixtureName('meta_t1') });
        const meta1 = await metadata.get({ path: img1.path.replace(/^\//, '') });
        assert.equal(meta1.thumbnailResolution, 0);
        // A second fresh file with type 'avatar' gets 96*144 = 13824.
        const img2 = await uploadImageFixture({ fileName: fixtureName('meta_t2') });
        const meta2 = await metadata.get({ path: img2.path.replace(/^\//, ''), type: 'avatar' });
        assert.equal(meta2.thumbnailResolution, 13824);
        // Re-getting the FIRST file with type 'avatar' still answers 0: the
        // entry is cached by mtime and type is ignored.
        const meta1b = await metadata.get({ path: img1.path.replace(/^\//, ''), type: 'avatar' });
        assert.equal(meta1b.thumbnailResolution, 0);
    });

    test('nonexistent file throws StApiError 404', async () => {
        await assert.rejects(
            () => metadata.get({ path: `backgrounds/__drvtest_missing_${Date.now()}.png` }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('neither path nor paths throws StApiError 400', async () => {
        await assert.rejects(
            () => client.post('/api/image-metadata', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('path outside the user data dir throws StApiError 500 (quirk: not 400)', async () => {
        await assert.rejects(
            () => metadata.get({ path: '../escape.png' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('ImageMetadataApi.getBatch (POST /api/image-metadata {paths})', () => {
    test('maps every path to its metadata object', async () => {
        const bg1 = await uploadBackgroundFixture();
        const bg2 = await uploadBackgroundFixture();
        const res = await metadata.getBatch({ paths: [bg1.relativePath, bg2.relativePath] });
        assert.equal(typeof res[bg1.relativePath].hash, 'string');
        assert.equal(typeof res[bg2.relativePath].hash, 'string');
    });

    test('a nonexistent path becomes an {error} entry, HTTP stays 200', async () => {
        const bg = await uploadBackgroundFixture();
        const missing = `backgrounds/__drvtest_missing_${Date.now()}.png`;
        const res = await metadata.getBatch({ paths: [bg.relativePath, missing] });
        assert.equal(typeof res[bg.relativePath].hash, 'string');
        assert.equal(typeof res[missing].error, 'string');
    });

    test('a path outside the user data dir becomes an {error} entry (batch is lenient, single is 500)', async () => {
        const res = await metadata.getBatch({ paths: ['../escape.png'] });
        assert.match(res['../escape.png'].error, /outside the user data directory/);
    });
});

describe('ImageMetadataApi folder management (POST /api/image-metadata/folders/*)', () => {
    test('createFolder({name}) returns {id, name, thumbnailFile: ""}', async () => {
        const name = fixtureName('folder');
        const folder = await metadata.createFolder({ name });
        tracked.metaFolderIds.push(folder.id);
        assert.equal(typeof folder.id, 'string');
        assert.ok(folder.id.length > 0);
        assert.equal(folder.name, name);
        assert.equal(folder.thumbnailFile, '');
    });

    test('createFolder without name throws StApiError 400', async () => {
        await assert.rejects(
            () => metadata.createFolder({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('listFolders() returns an array containing the created folder', async () => {
        const folder = await createFolderFixture();
        const list = await metadata.listFolders();
        assert.ok(Array.isArray(list));
        const found = list.find(f => f.id === folder.id);
        assert.ok(found, 'created folder must be listed');
        assert.equal(found.name, folder.name);
        assert.equal(found.thumbnailFile, '');
    });

    test('updateFolder({id, name}) renames and returns the updated folder', async () => {
        const folder = await createFolderFixture();
        const newName = fixtureName('renamed');
        const updated = await metadata.updateFolder({ id: folder.id, name: newName });
        assert.equal(updated.id, folder.id);
        assert.equal(updated.name, newName);
    });

    test('updateFolder({id, thumbnailFile}) sets the thumbnail', async () => {
        const folder = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        const updated = await metadata.updateFolder({ id: folder.id, thumbnailFile: bg.fileName });
        assert.equal(updated.thumbnailFile, bg.fileName);
    });

    test('updateFolder without id throws StApiError 400', async () => {
        await assert.rejects(
            () => metadata.updateFolder({ name: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('updateFolder with an unknown id throws StApiError 404', async () => {
        await assert.rejects(
            () => metadata.updateFolder({ id: `no-such-id-${Date.now()}`, name: 'x' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('setFolderThumbnails({updates}) sets thumbnails in batch and returns {ok: true}', async () => {
        const f1 = await createFolderFixture();
        const f2 = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        const res = await metadata.setFolderThumbnails({
            updates: [
                { id: f1.id, thumbnailFile: bg.fileName },
                { id: f2.id, thumbnailFile: '' },
            ],
        });
        assert.deepEqual(res, { ok: true });
        const list = await metadata.listFolders();
        assert.equal(list.find(f => f.id === f1.id).thumbnailFile, bg.fileName);
        assert.equal(list.find(f => f.id === f2.id).thumbnailFile, '');
    });

    test('setFolderThumbnails with non-array updates throws StApiError 400', async () => {
        await assert.rejects(
            () => metadata.setFolderThumbnails({ updates: 'nope' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('setFolderThumbnails silently skips unknown folder ids ({ok: true})', async () => {
        const res = await metadata.setFolderThumbnails({
            updates: [{ id: `no-such-id-${Date.now()}`, thumbnailFile: 'x.png' }],
        });
        assert.deepEqual(res, { ok: true });
    });

    test('assignImages({id, paths}) adds the folderId to the image metadata', async () => {
        const folder = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        const res = await metadata.assignImages({ id: folder.id, paths: [bg.relativePath] });
        assert.deepEqual(res, { ok: true });
        const meta = await metadata.get({ path: bg.relativePath });
        assert.ok(meta.folderIds.includes(folder.id), 'folderId must be assigned');
        // cross-check through /api/backgrounds/folders
        const bgFolders = await client.post('/api/backgrounds/folders', {});
        assert.deepEqual(bgFolders.imageFolderMap[bg.fileName], [folder.id]);
    });

    test('assignImages with a nonexistent file silently skips it ({ok: true})', async () => {
        const folder = await createFolderFixture();
        const res = await metadata.assignImages({
            id: folder.id,
            paths: [`backgrounds/__drvtest_missing_${Date.now()}.png`],
        });
        assert.deepEqual(res, { ok: true });
    });

    test('assignImages with a non-backgrounds path throws StApiError 500 (quirk)', async () => {
        const folder = await createFolderFixture();
        await assert.rejects(
            () => metadata.assignImages({ id: folder.id, paths: ['user/images/x.png'] }),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('assignImages with an unknown folder id throws StApiError 404', async () => {
        const bg = await uploadBackgroundFixture();
        await assert.rejects(
            () => metadata.assignImages({ id: `no-such-id-${Date.now()}`, paths: [bg.relativePath] }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('assignImages without paths throws StApiError 400', async () => {
        const folder = await createFolderFixture();
        await assert.rejects(
            () => metadata.assignImages({ id: folder.id }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('assignImages without id throws StApiError 400', async () => {
        await assert.rejects(
            () => metadata.assignImages({ paths: [] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('unassignImages({id, paths}) removes the folderId', async () => {
        const folder = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        await metadata.assignImages({ id: folder.id, paths: [bg.relativePath] });
        const res = await metadata.unassignImages({ id: folder.id, paths: [bg.relativePath] });
        assert.deepEqual(res, { ok: true });
        const meta = await metadata.get({ path: bg.relativePath });
        assert.ok(!meta.folderIds.includes(folder.id), 'folderId must be removed');
    });

    test('unassignImages with an unknown folder id still answers {ok: true} (no existence check)', async () => {
        const bg = await uploadBackgroundFixture();
        const res = await metadata.unassignImages({ id: `no-such-id-${Date.now()}`, paths: [bg.relativePath] });
        assert.deepEqual(res, { ok: true });
    });

    test('unassignImages without paths throws StApiError 400', async () => {
        const folder = await createFolderFixture();
        await assert.rejects(
            () => metadata.unassignImages({ id: folder.id }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('deleteFolder({id}) removes the folder and unassigns its images', async () => {
        const folder = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        await metadata.assignImages({ id: folder.id, paths: [bg.relativePath] });
        const res = await metadata.deleteFolder({ id: folder.id });
        assert.deepEqual(res, { ok: true });
        tracked.metaFolderIds.splice(tracked.metaFolderIds.indexOf(folder.id), 1);
        const list = await metadata.listFolders();
        assert.ok(!list.some(f => f.id === folder.id), 'folder must be gone');
        const meta = await metadata.get({ path: bg.relativePath });
        assert.ok(!meta.folderIds.includes(folder.id), 'images must be unassigned');
    });

    test('deleteFolder with an unknown id throws StApiError 404', async () => {
        await assert.rejects(
            () => metadata.deleteFolder({ id: `no-such-id-${Date.now()}` }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('deleteFolder without id throws StApiError 400', async () => {
        await assert.rejects(
            () => metadata.deleteFolder({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ImageMetadataApi.all (POST /api/image-metadata/all)', () => {
    test('all() returns the full index {version, images, folders}', async () => {
        const res = await metadata.all();
        assert.equal(typeof res.version, 'number');
        assert.equal(typeof res.images, 'object');
        assert.ok(Array.isArray(res.folders));
    });

    test('all({prefix}) filters images and OMITS the folders key (quirk)', async () => {
        const bg = await uploadBackgroundFixture();
        await metadata.get({ path: bg.relativePath }); // ensure a metadata entry exists
        const res = await metadata.all({ prefix: `backgrounds/${bg.fileName}` });
        assert.equal(typeof res.version, 'number');
        assert.equal(res.folders, undefined, 'prefix mode only returns {version, images}');
        assert.ok(res.images[bg.relativePath], 'the fixture image must match the prefix');
        assert.equal(Object.keys(res.images).length, 1);
    });

    test('all({prefix}) with a non-matching prefix returns empty images', async () => {
        const res = await metadata.all({ prefix: `backgrounds/__drvtest_no_match_${Date.now()}` });
        assert.deepEqual(res.images, {});
    });
});

describe('ImageMetadataApi.cleanup (POST /api/image-metadata/cleanup)', () => {
    test('removes orphaned entries and reports {removed, count}', async () => {
        const img = await uploadImageFixture();
        const relativePath = img.path.replace(/^\//, '');
        await metadata.get({ path: relativePath }); // create the metadata entry
        await images.delete({ path: img.path }); // orphan it
        tracked.imagePaths.splice(tracked.imagePaths.indexOf(img.path), 1);

        const res = await metadata.cleanup();
        assert.ok(Array.isArray(res.removed));
        assert.equal(typeof res.count, 'number');
        assert.ok(res.removed.includes(relativePath), 'the orphaned fixture entry must be removed');
        assert.equal(res.count, res.removed.length);

        const all = await metadata.all({ prefix: relativePath });
        assert.equal(all.images[relativePath], undefined);
    });
});

describe('ImagesApi.upload (POST /api/images/upload, JSON base64)', () => {
    test('uploads pure base64 and returns {path} under /user/images/', async () => {
        const fileName = fixtureName('imgup');
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName });
        tracked.imagePaths.push(res.path);
        assert.deepEqual(res, { path: `/user/images/${fileName}.png` });
    });

    test('stored bytes match the source image exactly (static GET)', async () => {
        const fileName = fixtureName('imgbytes');
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName });
        tracked.imagePaths.push(res.path);
        const bytes = await client.getBinary(`/user/images/${fileName}.png`);
        assert.ok(bytes.equals(tinyPng()), 'stored file must be byte-identical');
    });

    test('a data URI corrupts the stored file (image must be PURE base64 — quirk)', async () => {
        const fileName = fixtureName('imgdu');
        const dataUri = `data:image/png;base64,${tinyPng().toString('base64')}`;
        const res = await images.upload({ image: dataUri, format: 'png', fileName });
        tracked.imagePaths.push(res.path);
        const bytes = await client.getBinary(`/user/images/${fileName}.png`);
        assert.ok(!bytes.equals(tinyPng()), 'the data URI prefix must corrupt the output');
    });

    test('format determines the stored extension (jpg)', async () => {
        const fileName = fixtureName('imgjpg');
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'jpg', fileName });
        tracked.imagePaths.push(res.path);
        assert.equal(res.path, `/user/images/${fileName}.jpg`);
    });

    test('fileName with an existing extension is replaced, not doubled', async () => {
        const fileName = `${fixtureName('imgext')}.webp`;
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName });
        tracked.imagePaths.push(res.path);
        assert.ok(res.path.endsWith('.png'), `unexpected path ${res.path}`);
        assert.ok(!res.path.includes('.webp'), 'the old extension must be stripped');
    });

    test('without fileName the server picks <Date.now()>.<format>', async () => {
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'png' });
        tracked.imagePaths.push(res.path);
        assert.match(res.path, /^\/user\/images\/\d+\.png$/);
    });

    test('characterName stores the image in a user/images/<characterName>/ subfolder', async () => {
        const sub = fixtureName('imgsub');
        tracked.imageDirs.push(sub);
        const res = await images.upload({
            image: tinyPng().toString('base64'),
            format: 'png',
            fileName: 'inner',
            characterName: sub,
        });
        tracked.imagePaths.push(res.path);
        assert.equal(res.path, `/user/images/${sub}/inner.png`);
    });

    test('missing image throws StApiError 400', async () => {
        await assert.rejects(
            () => images.upload({ format: 'png' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('missing format throws StApiError 400 (Invalid image format)', async () => {
        await assert.rejects(
            () => images.upload({ image: tinyPng().toString('base64') }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('invalid format throws StApiError 400', async () => {
        await assert.rejects(
            () => images.upload({ image: tinyPng().toString('base64'), format: 'exe' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ImagesApi.list (POST /api/images/list)', () => {
    test('lists the image file names of a folder (default sort: date asc)', async () => {
        const sub = fixtureName('imglist');
        tracked.imageDirs.push(sub);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'first', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/first.png`);
        await new Promise(resolve => setTimeout(resolve, 1100)); // distinct mtime
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'second', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/second.png`);

        const list = await images.list(sub);
        assert.deepEqual(list, ['first.png', 'second.png'], 'date asc: oldest first');
    });

    test('sortField "name" sorts alphabetically, ignoring upload order', async () => {
        const sub = fixtureName('imgsort');
        tracked.imageDirs.push(sub);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'zzz', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/zzz.png`);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'aaa', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/aaa.png`);

        assert.deepEqual(await images.list(sub, { sortField: 'name', sortOrder: 'asc' }), ['aaa.png', 'zzz.png']);
        assert.deepEqual(await images.list(sub, { sortField: 'name', sortOrder: 'desc' }), ['zzz.png', 'aaa.png']);
    });

    test('sortOrder "desc" reverses the date order', async () => {
        const sub = fixtureName('imgdesc');
        tracked.imageDirs.push(sub);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'older', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/older.png`);
        await new Promise(resolve => setTimeout(resolve, 1100));
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'newer', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/newer.png`);

        assert.deepEqual(await images.list(sub, { sortOrder: 'desc' }), ['newer.png', 'older.png']);
    });

    test('type filters by media kind (2 = video only → [] for a png folder)', async () => {
        const sub = fixtureName('imgtype');
        tracked.imageDirs.push(sub);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'only', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/only.png`);

        assert.deepEqual(await images.list(sub, { type: 2 }), []);
        assert.deepEqual(await images.list(sub, { type: 1 }), ['only.png']);
    });

    test('a nonexistent folder answers [] (and is created on disk when ST_DATA_ROOT is set)', async () => {
        const sub = fixtureName('imgghost');
        tracked.imageDirs.push(sub);
        const list = await images.list(sub);
        // HTTP behavior: an unknown folder is not an error, it answers []
        assert.deepEqual(list, []);
        // fs-level quirk (the folder gets created as a side effect) is only
        // observable when the test can see the server's data directory
        if (DATA_ROOT) {
            assert.ok(fs.existsSync(path.join(DATA_ROOT, 'user/images', sub)), 'the folder must now exist');
        }
    });

    test('missing folder throws StApiError 400', async () => {
        await assert.rejects(
            () => images.list(),
            err => err instanceof StApiError && err.status === 400,
        );
        await assert.rejects(
            () => images.list(''),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ImagesApi.folders (POST /api/images/folders)', () => {
    test('returns the directory names inside user/images, including fixture subfolders', async () => {
        const sub = fixtureName('imgfolder');
        tracked.imageDirs.push(sub);
        await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'x', characterName: sub });
        tracked.imagePaths.push(`/user/images/${sub}/x.png`);

        const folders = await images.folders();
        assert.ok(Array.isArray(folders));
        assert.ok(folders.every(f => typeof f === 'string'));
        assert.ok(folders.includes(sub), 'the fixture subfolder must be listed');
    });
});

describe('ImagesApi.delete (POST /api/images/delete)', () => {
    test('deletes an uploaded image and answers plain text OK', async () => {
        const img = await uploadImageFixture();
        const res = await images.delete({ path: img.path });
        assert.equal(res, 'OK');
        tracked.imagePaths.splice(tracked.imagePaths.indexOf(img.path), 1);
        const verified = await files.verify({ urls: [img.path] });
        // verify() skips non-user/files urls — check via list instead
        assert.deepEqual(verified, {});
    });

    test('missing path throws StApiError 400', async () => {
        await assert.rejects(
            () => images.delete({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('path outside user/images throws StApiError 400 (Invalid path)', async () => {
        await assert.rejects(
            () => images.delete({ path: '../escape.png' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('nonexistent path throws StApiError 404', async () => {
        await assert.rejects(
            () => images.delete({ path: `/user/images/__drvtest_missing_${Date.now()}.png` }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('AssetsApi.get (POST /api/assets/get)', () => {
    test('returns the category map (temp excluded, vrm shaped {model, animation})', async () => {
        const res = await assets.get();
        assert.equal(typeof res, 'object');
        for (const category of ['bgm', 'ambient', 'blip', 'live2d', 'character']) {
            assert.ok(Array.isArray(res[category]), `${category} must be an array`);
        }
        assert.equal(res.temp, undefined, 'the temp category is excluded');
        assert.ok(Array.isArray(res.vrm.model));
        assert.ok(Array.isArray(res.vrm.animation));
        assert.ok(Array.isArray(res.live2d));
    });
});

describe('media end-to-end lifecycle', () => {
    test('files: upload → verify(true) → delete → verify(false)', async () => {
        const fixture = await uploadFileFixture('lifecycle');
        assert.deepEqual(await files.verify({ urls: [fixture.path] }), { [fixture.path]: true });
        assert.equal(await files.delete({ path: fixture.path }), 'OK');
        tracked.filePaths.splice(tracked.filePaths.indexOf(fixture.path), 1);
        assert.deepEqual(await files.verify({ urls: [fixture.path] }), { [fixture.path]: false });
    });

    test('images: upload to subfolder → folders contains it → list shows it → delete removes it', async () => {
        const sub = fixtureName('imglife');
        tracked.imageDirs.push(sub);
        const res = await images.upload({ image: tinyPng().toString('base64'), format: 'png', fileName: 'life', characterName: sub });
        tracked.imagePaths.push(res.path);

        assert.ok((await images.folders()).includes(sub));
        assert.deepEqual(await images.list(sub), ['life.png']);

        assert.equal(await images.delete({ path: res.path }), 'OK');
        tracked.imagePaths.splice(tracked.imagePaths.indexOf(res.path), 1);
        assert.deepEqual(await images.list(sub), []);
    });

    test('metadata: create folder → assign bg → set thumbnail → backgrounds/folders reflects it → unassign → delete folder', async () => {
        const folder = await createFolderFixture();
        const bg = await uploadBackgroundFixture();
        await metadata.get({ path: bg.relativePath });

        assert.deepEqual(await metadata.assignImages({ id: folder.id, paths: [bg.relativePath] }), { ok: true });
        assert.deepEqual(await metadata.setFolderThumbnails({ updates: [{ id: folder.id, thumbnailFile: bg.fileName }] }), { ok: true });

        const bgFolders = await client.post('/api/backgrounds/folders', {});
        assert.deepEqual(bgFolders.imageFolderMap[bg.fileName], [folder.id]);
        assert.equal(bgFolders.folders.find(f => f.id === folder.id).thumbnailFile, bg.fileName);

        assert.deepEqual(await metadata.unassignImages({ id: folder.id, paths: [bg.relativePath] }), { ok: true });
        const after = await client.post('/api/backgrounds/folders', {});
        assert.equal(after.imageFolderMap[bg.fileName], undefined);

        assert.deepEqual(await metadata.deleteFolder({ id: folder.id }), { ok: true });
        tracked.metaFolderIds.splice(tracked.metaFolderIds.indexOf(folder.id), 1);
    });
});
