/**
 * LIVE integration tests for the maintenance APIs (src/api/maintenance.js):
 * StatsApi (/api/stats), BackupsApi (/api/backups/chat) and DataMaidApi
 * (/api/data-maid).
 *
 * Safety policy (this runs against the user's daily instance):
 * - Only read-only calls plus error paths on nonexistent/invalid inputs are
 *   exercised live.
 * - StatsApi.recreate()/update() are implemented but their live tests are
 *   SKIPPED: recreate rescans every chat file and rewrites stats.json, update
 *   overwrites the in-memory stats object - both mutate real user statistics.
 * - BackupsApi.download() is only tested on its error paths (404/400); a
 *   successful download would pull a real user chat backup.
 * - DataMaidApi.delete() is only tested with an INVALID token (403/400); a
 *   valid token would unlink real user files. Every token minted by these
 *   tests is finalized inside the test, and after() finalizes any leftover
 *   token as a safety net.
 *
 * Live quirks verified against ST 1.18.0:
 * - POST /api/backups/chat/delete (and /download) without `name` answer 500,
 *   not 400: the server runs the value through sanitize-filename, which throws
 *   on undefined. The wrapper validates `name` client-side.
 * - POST /api/data-maid/report invalidates every previously issued token for
 *   the same user (only the newest token stays valid).
 * - /api/data-maid/report parses every chat file server-side; ~1s on the test
 *   instance but can take much longer on big installs (generous timeouts).
 * - data-maid error bodies are bare status texts ('Forbidden', 'Bad Request',
 *   'Not Found'), not JSON.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StatsApi, BackupsApi, DataMaidApi } from '../../src/api/maintenance.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName } from '../helpers.js';

let client;
let stats;
let backups;
let maid;
/** Newest data-maid token still open; finalized by after() as a safety net. */
let openMaidToken = null;

before(async () => {
    client = await newClient();
    stats = new StatsApi(client);
    backups = new BackupsApi(client);
    maid = new DataMaidApi(client);
});

after(async () => {
    // Safety net: never leave a data-maid token alive on the server.
    if (openMaidToken) {
        await maid.finalize({ token: openMaidToken }).catch(() => {});
        openMaidToken = null;
    }
    await client?.close();
});

/** The nine sanitized categories every data-maid report must contain. */
const MAID_CATEGORIES = [
    'images',
    'files',
    'chats',
    'groupChats',
    'avatarThumbnails',
    'backgroundThumbnails',
    'personaThumbnails',
    'chatBackups',
    'settingsBackups',
];

describe('StatsApi.get (POST /api/stats/get)', () => {
    test('get returns the stats object tagged with a numeric timestamp', async () => {
        const res = await stats.get();
        assert.equal(typeof res, 'object');
        assert.ok(res !== null && !Array.isArray(res));
        // The server always tags the payload with the generation time; on a
        // fresh/user instance this may be the ONLY key (verified live:
        // {"timestamp": ...} with no per-character entries).
        assert.equal(typeof res.timestamp, 'number');
        assert.ok(Number.isFinite(res.timestamp));
    });

    test('get tags every per-character entry with the nine numeric stat fields', async () => {
        const res = await stats.get();
        const entries = Object.entries(res).filter(([key]) => key !== 'timestamp');
        // May legitimately be empty on this instance; the shape check then
        // passes vacuously. Keys are character avatar file names ('Foo.png').
        const fields = [
            'total_gen_time',
            'user_word_count',
            'non_user_word_count',
            'user_msg_count',
            'non_user_msg_count',
            'total_swipe_count',
            'chat_size',
            'date_last_chat',
            'date_first_chat',
        ];
        for (const [key, value] of entries) {
            assert.equal(typeof key, 'string');
            assert.equal(typeof value, 'object', `entry ${key} must be an object`);
            for (const field of fields) {
                assert.equal(typeof value[field], 'number', `${key}.${field} must be a number`);
            }
        }
    });
});

describe('StatsApi.recreate (POST /api/stats/recreate)', () => {
    // Implemented in the wrapper, but calling it live would rescan every chat
    // file of the user and rewrite stats.json - never run against a daily
    // instance.
    test("recreate rebuilds the stats from all chat files and returns the 'OK' status text", { skip: 'mutates user stats' }, async () => {
        const res = await stats.recreate();
        assert.equal(res, 'OK', 'sendStatus(200) answers the plain text "OK"');
    });
});

describe('StatsApi.update (POST /api/stats/update)', () => {
    // Implemented in the wrapper, but calling it live would overwrite the
    // user's in-memory stats object (persisted to stats.json within 5 minutes
    // by the server's save interval) - never run against a daily instance.
    test("update replaces the whole stats object and returns the 'OK' status text", { skip: 'mutates user stats' }, async () => {
        const res = await stats.update({ timestamp: Date.now() });
        assert.equal(res, 'OK', 'sendStatus(200) answers the plain text "OK"');
    });

    test('update with a non-object payload rejects client-side (TypeError)', async () => {
        await assert.rejects(
            () => stats.update('not-an-object'),
            err => err instanceof TypeError && /stats object/.test(err.message),
        );
    });
});

describe('BackupsApi.get (POST /api/backups/chat/get)', () => {
    test('get lists chat backups, every file_name carrying the chat_ prefix and .jsonl extension', async () => {
        const res = await backups.get();
        assert.ok(Array.isArray(res));
        for (const entry of res) {
            assert.equal(typeof entry.file_name, 'string');
            assert.ok(entry.file_name.startsWith('chat_'), `unexpected backup name ${entry.file_name}`);
            assert.ok(entry.file_name.endsWith('.jsonl'));
            assert.equal(entry.file_id, entry.file_name.slice(0, -'.jsonl'.length));
            assert.equal(typeof entry.chat_items, 'number');
            assert.equal(typeof entry.file_size, 'string', 'file_size is a humanized string like "2.67KB"');
            // last_mes is the last message send_date (string) or, for empty
            // files, the mtime (number) - both shapes verified in source.
            assert.ok(typeof entry.last_mes === 'string' || typeof entry.last_mes === 'number');
        }
    });
});

describe('BackupsApi.delete (POST /api/backups/chat/delete)', () => {
    test('delete of a nonexistent chat_ backup throws StApiError 404', async () => {
        const name = `chat_${fixtureName('bk')}.jsonl`;
        await assert.rejects(
            () => backups.delete({ name }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('delete of a name without the chat_ prefix throws StApiError 400 (rejected before any disk access)', async () => {
        await assert.rejects(
            () => backups.delete({ name: `${fixtureName('settings')}.json` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete without a name rejects client-side (TypeError); raw server answers 500 (sanitize-filename throws on undefined)', async () => {
        await assert.rejects(
            () => backups.delete({}),
            err => err instanceof TypeError && /'name' is required/.test(err.message),
        );
        // ST quirk: missing parameter answers 500, not 400. Safe to probe -
        // the server throws before touching the file system.
        await assert.rejects(
            () => client.post('/api/backups/chat/delete', {}),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackupsApi.download (POST /api/backups/chat/download)', () => {
    // NOTE: only error paths are tested. A successful download would fetch a
    // real user chat backup - unnecessary and slow on a live instance.
    test('download of a nonexistent chat_ backup throws StApiError 404', async () => {
        const name = `chat_${fixtureName('bk')}.jsonl`;
        await assert.rejects(
            () => backups.download({ name }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('download of a name without the chat_ prefix throws StApiError 400', async () => {
        await assert.rejects(
            () => backups.download({ name: `${fixtureName('settings')}.json` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('download without a name rejects client-side (TypeError); raw server answers 500', async () => {
        await assert.rejects(
            () => backups.download({}),
            err => err instanceof TypeError && /'name' is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postBinary('/api/backups/chat/download', {}),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('DataMaidApi.report (POST /api/data-maid/report)', () => {
    test('report returns {report, token} with a 64-hex token and all nine sanitized categories', async (t) => {
        // The report scans (and parses) every chat file - allow generous time.
        t.timeout = 120_000;
        const res = await maid.report();
        assert.equal(typeof res.token, 'string');
        assert.match(res.token, /^[0-9a-f]{64}$/);
        openMaidToken = res.token;

        assert.equal(typeof res.report, 'object');
        for (const category of MAID_CATEGORIES) {
            assert.ok(Array.isArray(res.report[category]), `report.${category} must be an array`);
            for (const record of res.report[category]) {
                assert.equal(typeof record.name, 'string');
                assert.match(record.hash, /^[0-9a-f]{64}$/, 'record hash is the sha256 of the file path');
                // size/mtime are present only when the file could be stat'ed;
                // parent only for the with-parent categories.
                if (record.size !== undefined) assert.equal(typeof record.size, 'number');
                if (record.mtime !== undefined) assert.equal(typeof record.mtime, 'number');
            }
        }

        // Never leave the token alive.
        await maid.finalize({ token: res.token });
        openMaidToken = null;
    });

    test('report invalidates any previously issued token for the same user (only the newest works)', async (t) => {
        t.timeout = 120_000;
        const first = await maid.report();
        const second = await maid.report();
        assert.notEqual(first.token, second.token);
        openMaidToken = second.token;
        // The first token was dropped server-side when the second was minted.
        await assert.rejects(
            () => maid.finalize({ token: first.token }),
            err => err instanceof StApiError && err.status === 403,
        );
        await maid.finalize({ token: second.token });
        openMaidToken = null;
    });
});

describe('DataMaidApi.finalize (POST /api/data-maid/finalize)', () => {
    test('finalize with an unknown token throws StApiError 403', async () => {
        await assert.rejects(
            () => maid.finalize({ token: 'deadbeef'.repeat(8) }),
            err => err instanceof StApiError && err.status === 403,
        );
    });

    test('finalize without a token throws StApiError 400', async () => {
        await assert.rejects(
            () => maid.finalize({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('lifecycle: report -> finalize answers 204 (null) and the spent token then fails with 403', async (t) => {
        t.timeout = 120_000;
        const { token } = await maid.report();
        openMaidToken = token;
        const res = await maid.finalize({ token });
        assert.equal(res, null, '204 No Content maps to null');
        openMaidToken = null;
        await assert.rejects(
            () => maid.finalize({ token }),
            err => err instanceof StApiError && err.status === 403,
        );
    });
});

describe('DataMaidApi.view (GET /api/data-maid/view?token=&hash=)', () => {
    // NOTE: only error paths are tested - a successful view would read a real
    // loose user file (image/chat/backup) from disk.
    test('view without token and hash throws StApiError 400', async () => {
        await assert.rejects(
            () => maid.view({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('view with an invalid token throws StApiError 403', async () => {
        await assert.rejects(
            () => maid.view({ token: 'deadbeef'.repeat(8), hash: 'deadbeef' }),
            err => err instanceof StApiError && err.status === 403,
        );
    });

    test('view with a valid token but an unknown hash throws StApiError 404', async (t) => {
        t.timeout = 120_000;
        const { token } = await maid.report();
        openMaidToken = token;
        try {
            await assert.rejects(
                () => maid.view({ token, hash: 'deadbeef'.repeat(8) }),
                err => err instanceof StApiError && err.status === 404,
            );
        } finally {
            await maid.finalize({ token }).catch(() => {});
            openMaidToken = null;
        }
    });
});

describe('DataMaidApi.delete (POST /api/data-maid/delete)', () => {
    // NOTE: only INVALID-token error paths are tested. With a valid token the
    // server unlinks real loose user files - never exercised here.
    test('delete with an invalid token throws StApiError 403 (nothing is deleted)', async () => {
        await assert.rejects(
            () => maid.delete({ token: 'deadbeef'.repeat(8), hashes: ['deadbeef'] }),
            err => err instanceof StApiError && err.status === 403,
        );
    });

    test('delete without hashes throws StApiError 400', async () => {
        await assert.rejects(
            () => maid.delete({ token: 'deadbeef'.repeat(8) }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete with an empty hashes array throws StApiError 400', async () => {
        await assert.rejects(
            () => maid.delete({ token: 'deadbeef'.repeat(8), hashes: [] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});
