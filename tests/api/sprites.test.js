/**
 * LIVE integration tests for SpritesApi (src/api/sprites.js).
 *
 * All fixture character names use the __drvtest_ prefix. Sprites live in
 * characters/<name>/ directories, which ST creates automatically on upload —
 * no real character card is needed. The directories are removed in after().
 *
 * Verified quirks (ST 1.18.0):
 * - GET /api/sprites/get?name= answers with a JSON array [{label, path}] —
 *   NOT binary and NOT 404. An unknown character simply yields [].
 * - /upload and /upload-zip answer {ok: true} / {ok: true, count}.
 * - /delete answers 200 with plain text 'OK'; deleting a nonexistent sprite
 *   from an existing folder still answers 200 (the loop matches nothing).
 *   Unknown character folder -> 404. Missing label+spriteName -> 400.
 * - Sending NO name field to /upload would create a literal
 *   'characters/undefined' folder (String(undefined) is truthy), so that
 *   error path is deliberately NOT exercised here.
 * - Deleting every sprite leaves the (now empty) character directory behind;
 *   there is no HTTP endpoint to remove it, so cleanup uses the filesystem
 *   (ST_DATA_ROOT env, default: the local SillyTavern data dir).
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SpritesApi } from '../../src/api/sprites.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, tinyPng, dataRoot } from '../helpers.js';

let client;
let api;
/** Every fixture character name used, for after() directory cleanup. */
const fixtureChars = [];

/**
 * ST user data root (for removing empty sprite directories after tests).
 * Opt-in via ST_DATA_ROOT; null disables the fs-level sweep/assertions.
 */
const DATA_ROOT = dataRoot();

before(async () => {
    client = await newClient();
    api = new SpritesApi(client);
});

after(async () => {
    // Remove sprite files via the API first (also exercises delete), then the
    // leftover empty directories via fs (no HTTP endpoint exists for that).
    for (const name of fixtureChars) {
        try {
            const sprites = await api.get(name);
            for (const s of sprites) {
                const fileName = path.posix.basename(s.path.split('?')[0]);
                const label = path.parse(fileName).name;
                await api.delete({ name, spriteName: label }).catch(() => {});
            }
        } catch { /* ignore */ }
        // The API removed the sprite files; the leftover empty directory can only
        // be swept from disk, which requires ST_DATA_ROOT to point at this server.
        if (DATA_ROOT) {
            fs.rmSync(path.join(DATA_ROOT, 'characters', name), { recursive: true, force: true });
        }
    }
    await client?.close();
});

/**
 * Register a fixture character name for cleanup.
 * @param {string} [scope]
 * @returns {string}
 */
function trackChar(scope = 'sprite') {
    const name = fixtureName(scope);
    fixtureChars.push(name);
    return name;
}

/**
 * Build a minimal valid ZIP file (store method, no compression) without any
 * dependency: local file headers + central directory + EOCD, CRC-32 computed
 * by hand. Verified against ST's yauzl-based getImageBuffers() extractor.
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
    /**
     * CRC-32 (IEEE) of a buffer.
     * @param {Buffer} buf
     * @returns {number}
     */
    function crc32(buf) {
        let crc = 0xffffffff;
        for (let n = 0; n < buf.length; n++) {
            let c = (crc ^ buf[n]) & 0xff;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crc = c ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    const chunks = [];
    const central = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01, the DOS epoch

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const crc = crc32(entry.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // local file header signature
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // method: store
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(entry.data.length, 18); // compressed size
        local.writeUInt32LE(entry.data.length, 22); // uncompressed size
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        chunks.push(local, nameBuf, entry.data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); // central directory signature
        cd.writeUInt16LE(20, 4); // version made by
        cd.writeUInt16LE(20, 6); // version needed
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(dosTime, 12);
        cd.writeUInt16LE(dosDate, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(entry.data.length, 20);
        cd.writeUInt32LE(entry.data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30); // extra
        cd.writeUInt16LE(0, 32); // comment
        cd.writeUInt16LE(0, 34); // disk
        cd.writeUInt16LE(0, 36); // internal attrs
        cd.writeUInt32LE(0, 38); // external attrs
        cd.writeUInt32LE(offset, 42); // local header offset
        central.push(Buffer.concat([cd, nameBuf]));

        offset += 30 + nameBuf.length + entry.data.length;
    }

    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, cdBuf, eocd]);
}

describe('SpritesApi.get(name) — GET /api/sprites/get?name=', () => {
    test('get for an unknown character returns [] (HTTP 200, JSON — not binary, not 404)', async () => {
        const sprites = await api.get(`__drvtest_no_such_char_${Date.now().toString(36)}`);
        assert.deepEqual(sprites, []);
    });

    test('get after upload returns [{label, path}] for every sprite', async () => {
        const name = trackChar('sp_get');
        await api.upload({ name, label: 'joy' }, tinyPng());
        await api.upload({ name, label: 'anger' }, tinyPng());
        const sprites = await api.get(name);
        assert.equal(sprites.length, 2);
        const labels = sprites.map(s => s.label).sort();
        assert.deepEqual(labels, ['anger', 'joy']);
    });

    test('get path points at /characters/<name>/<file> with an ?t= cache-buster', async () => {
        const name = trackChar('sp_path');
        await api.upload({ name, label: 'smile' }, tinyPng());
        const [sprite] = await api.get(name);
        assert.ok(sprite.path.startsWith(`/characters/${name}/smile.png`), `unexpected path ${sprite.path}`);
        assert.match(sprite.path, /\?t=\d{14}$/, 'path must carry a 14-digit mtime query');
    });

    test('label is lowercased and stripped of -/. suffixes (joy-1.png, joy.expressive.png -> joy)', async () => {
        const name = trackChar('sp_label');
        await api.upload({ name, label: 'joy', spriteName: 'joy-1' }, tinyPng());
        await api.upload({ name, label: 'joy', spriteName: 'joy.expressive' }, tinyPng());
        const sprites = await api.get(name);
        assert.deepEqual(sprites.map(s => s.label).sort(), ['joy', 'joy']);
    });
});

describe('SpritesApi.upload({name, label, spriteName?}, buffer) — POST /api/sprites/upload (multipart)', () => {
    test('upload stores the sprite under <label>.<ext> and returns {ok: true}', async () => {
        const name = trackChar('sp_up');
        const res = await api.upload({ name, label: 'happy' }, tinyPng());
        assert.deepEqual(res, { ok: true });
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1);
        assert.equal(sprites[0].label, 'happy');
    });

    test('upload with spriteName stores the file under spriteName instead of label', async () => {
        const name = trackChar('sp_sn');
        const res = await api.upload({ name, label: 'happy', spriteName: 'glad' }, tinyPng());
        assert.deepEqual(res, { ok: true });
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1);
        assert.ok(sprites[0].path.includes('/glad.png'), `expected glad.png, got ${sprites[0].path}`);
    });

    test('upload creates the character sprites folder on demand (no character card needed)', async () => {
        const name = trackChar('sp_dir');
        const res = await api.upload({ name, label: 'x' }, tinyPng());
        assert.deepEqual(res, { ok: true });
        // HTTP proof: the sprite is retrievable even though no character card exists
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1, 'the sprite must be listable after upload');
        // fs proof (folder created on disk) only when we can see the data dir
        if (DATA_ROOT) {
            assert.ok(fs.existsSync(path.join(DATA_ROOT, 'characters', name)), 'folder must exist on disk');
        }
    });

    test('upload overwrites an existing sprite with the same name', async () => {
        const name = trackChar('sp_ow');
        await api.upload({ name, label: 'dupe' }, tinyPng());
        await api.upload({ name, label: 'dupe' }, tinyPng());
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1, 'second upload must replace, not duplicate');
    });

    test('upload keeps the uploaded file extension (jpg stays jpg)', async () => {
        const name = trackChar('sp_ext');
        await api.upload({ name, label: 'pic' }, tinyPng(), { fileName: 'pic.jpg' });
        const sprites = await api.get(name);
        assert.ok(sprites[0].path.includes('/pic.jpg'), `expected pic.jpg, got ${sprites[0].path}`);
    });

    test('upload without a file throws StApiError 400', async () => {
        const name = trackChar('sp_nofile');
        await assert.rejects(
            () => client.postFormJson('/api/sprites/upload', { name, label: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('upload without label rejects client-side (TypeError); raw server answers 400', async () => {
        const name = trackChar('sp_nolabel');
        await assert.rejects(
            () => api.upload({ name }, tinyPng()),
            err => err instanceof TypeError && /'label'/.test(err.message),
        );
        // the server itself answers 400 when the label field is truly absent
        await assert.rejects(
            () => client.postFormJson(
                '/api/sprites/upload',
                { name },
                { fieldName: 'avatar', fileName: 'x.png', mimeType: 'image/png', data: tinyPng() },
            ),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SpritesApi.uploadZip(name, zipBuffer) — POST /api/sprites/upload-zip (multipart)', () => {
    test('uploadZip extracts image entries and returns {ok: true, count}', async () => {
        const name = trackChar('sp_zip');
        const zip = makeZip([
            { name: 'smile.png', data: tinyPng() },
            { name: 'angry.png', data: tinyPng() },
        ]);
        const res = await api.uploadZip(name, zip);
        assert.equal(res.ok, true);
        assert.equal(res.count, 2);
        const sprites = await api.get(name);
        assert.deepEqual(sprites.map(s => s.label).sort(), ['angry', 'smile']);
    });

    test('uploadZip ignores non-image entries in the count', async () => {
        const name = trackChar('sp_zip2');
        const zip = makeZip([
            { name: 'one.png', data: tinyPng() },
            { name: 'notes.txt', data: Buffer.from('not an image') },
        ]);
        const res = await api.uploadZip(name, zip);
        assert.equal(res.count, 1, 'only the image entry counts');
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1);
        assert.equal(sprites[0].label, 'one');
    });

    test('uploadZip replaces existing sprites with the same base name', async () => {
        const name = trackChar('sp_zip3');
        await api.upload({ name, label: 'dup' }, tinyPng());
        const zip = makeZip([{ name: 'dup.png', data: tinyPng() }]);
        const res = await api.uploadZip(name, zip);
        assert.equal(res.ok, true);
        const sprites = await api.get(name);
        assert.equal(sprites.length, 1);
    });

    test('uploadZip without a file throws StApiError 400', async () => {
        const name = trackChar('sp_zipnf');
        await assert.rejects(
            () => client.postFormJson('/api/sprites/upload-zip', { name }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SpritesApi.delete({name, label?, spriteName?}) — POST /api/sprites/delete', () => {
    test('delete by label removes the sprite and returns plain text OK', async () => {
        const name = trackChar('sp_del');
        await api.upload({ name, label: 'doomed' }, tinyPng());
        const res = await api.delete({ name, label: 'doomed' });
        assert.equal(res, 'OK', 'sendStatus(200) body is plain text OK');
        assert.deepEqual(await api.get(name), []);
    });

    test('delete by spriteName removes a sprite stored under a custom name', async () => {
        const name = trackChar('sp_delsn');
        await api.upload({ name, label: 'happy', spriteName: 'glad' }, tinyPng());
        const res = await api.delete({ name, spriteName: 'glad' });
        assert.equal(res, 'OK');
        assert.deepEqual(await api.get(name), []);
    });

    test('delete of a nonexistent sprite in an existing folder still returns 200 OK', async () => {
        const name = trackChar('sp_delmiss');
        await api.upload({ name, label: 'keeper' }, tinyPng());
        const res = await api.delete({ name, label: 'no_such_sprite' });
        assert.equal(res, 'OK');
        assert.equal((await api.get(name)).length, 1, 'other sprites are untouched');
    });

    test('delete for an unknown character throws StApiError 404', async () => {
        await assert.rejects(
            () => api.delete({ name: `__drvtest_no_such_char_${Date.now().toString(36)}`, label: 'x' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('delete without label and spriteName rejects client-side (TypeError); raw server answers 400', async () => {
        const name = trackChar('sp_delnolbl');
        await api.upload({ name, label: 'x' }, tinyPng());
        await assert.rejects(
            () => api.delete({ name }),
            err => err instanceof TypeError && /label or spriteName/.test(err.message),
        );
        // the server itself answers 400 when both fields are truly absent
        await assert.rejects(
            () => client.postRaw('/api/sprites/delete', { name }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('SpritesApi end-to-end lifecycle', () => {
    test('upload → get → uploadZip → delete each sprite → get returns []', async () => {
        const name = trackChar('sp_life');
        await api.upload({ name, label: 'base' }, tinyPng());
        assert.equal((await api.get(name)).length, 1);

        const zip = makeZip([{ name: 'extra.png', data: tinyPng() }]);
        const zipRes = await api.uploadZip(name, zip);
        assert.equal(zipRes.ok, true);
        assert.equal((await api.get(name)).length, 2);

        assert.equal(await api.delete({ name, label: 'base' }), 'OK');
        assert.equal(await api.delete({ name, spriteName: 'extra' }), 'OK');
        assert.deepEqual(await api.get(name), []);
    });
});
