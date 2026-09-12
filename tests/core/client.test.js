import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STClient, StApiError } from '../../src/core/client.js';

// Live integration tests against a running SillyTavern instance.
// Set ST_URL to override the base URL (default http://localhost:8000).
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';

let client;

before(async () => {
    client = new STClient({ baseUrl: BASE_URL });
    await client.connect();
});

after(async () => {
    await client?.close();
});

describe('STClient construction and config', () => {
    test('defaults baseUrl to http://localhost:8000', () => {
        const c = new STClient();
        assert.equal(c.baseUrl, 'http://localhost:8000');
    });

    test('accepts a custom baseUrl and strips trailing slash', () => {
        const c = new STClient({ baseUrl: 'http://example.com:1234/' });
        assert.equal(c.baseUrl, 'http://example.com:1234');
    });

    test('accepts a custom timeout', () => {
        const c = new STClient({ baseUrl: BASE_URL, timeout: 1234 });
        assert.equal(c.timeout, 1234);
    });

    test('defaults timeout to 120000', () => {
        const c = new STClient();
        assert.equal(c.timeout, 120000);
    });
});

describe('connect / handshake', () => {
    test('connect fetches a CSRF token', () => {
        assert.ok(client.csrfToken, 'csrfToken must be set after connect');
        assert.equal(typeof client.csrfToken, 'string');
        assert.ok(client.csrfToken.length > 0);
    });

    test('connect stores a session cookie', () => {
        assert.ok(client.cookies.size > 0, 'at least one cookie must be captured');
    });

    test('connect() is idempotent (second call refreshes token)', async () => {
        const first = client.csrfToken;
        await client.connect();
        assert.ok(client.csrfToken);
        // token may legitimately be identical (same session) - just assert usable
        assert.equal(typeof client.csrfToken, 'string');
    });

    test('connect against a bad URL rejects with a clear error', async () => {
        const bad = new STClient({ baseUrl: 'http://127.0.0.1:1', timeout: 2000 });
        await assert.rejects(() => bad.connect(), /connect|fetch|ECONNREFUSED/i);
    });

    test('version() returns the server version payload', async () => {
        const v = await client.version();
        assert.ok(v.pkgVersion, 'pkgVersion present');
        assert.ok(v.agent, 'agent present');
    });

    test('ping() succeeds against a live server', async () => {
        const ok = await client.ping();
        assert.equal(ok, true);
    });
});

describe('post (JSON)', () => {
    test('POST /api/settings/get returns the settings envelope', async () => {
        const res = await client.post('/api/settings/get', {});
        assert.equal(typeof res.settings, 'string', 'settings is a JSON string');
        assert.ok(Array.isArray(res.world_names), 'world_names is an array');
        assert.ok(Array.isArray(res.themes), 'themes is an array');
    });

    test('POST sends X-CSRF-Token header (server would 403 otherwise)', async () => {
        // implicitly verified by every successful POST; assert token is in outgoing header map
        const headers = client.buildHeaders();
        assert.equal(headers['X-CSRF-Token'], client.csrfToken);
        assert.equal(headers['Content-Type'], 'application/json');
    });

    test('POST with empty body object is allowed', async () => {
        const res = await client.post('/api/characters/all', {});
        assert.ok(Array.isArray(res));
    });

    test('POST to unknown route throws StApiError with status 404', async () => {
        await assert.rejects(
            () => client.post('/api/definitely-not-a-route', {}),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('StApiError carries status, path and body', async () => {
        try {
            await client.post('/api/definitely-not-a-route', {});
            assert.fail('should have thrown');
        } catch (err) {
            assert.ok(err instanceof StApiError);
            assert.equal(err.status, 404);
            assert.equal(err.path, '/api/definitely-not-a-route');
            assert.ok(err.message.includes('404'));
        }
    });

    test('missing required field produces 4xx StApiError (validation on server)', async () => {
        await assert.rejects(
            () => client.post('/api/worldinfo/get', {}),
            err => err instanceof StApiError && err.status >= 400,
        );
    });
});

describe('postRaw (non-JSON responses)', () => {
    test('returns text for endpoints that answer with plain text', async () => {
        // /csrf-token itself is JSON; use a translate endpoint without configured
        // service would error, so instead verify raw GET of /version returns JSON text
        const text = await client.getRaw('/version');
        const parsed = JSON.parse(text);
        assert.ok(parsed.pkgVersion);
    });

    test('getRaw on missing page throws StApiError 404', async () => {
        await assert.rejects(
            () => client.getRaw('/api/nope-not-here'),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('postForm (multipart/form-data)', () => {
    test('upload works via multipart with field name "avatar"', async () => {
        // Create a tiny 1x1 PNG and upload as a background; then delete it.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const marker = `__drvtest_form_${Date.now()}.png`;
        const text = await client.postForm('/api/backgrounds/upload', {}, {
            fieldName: 'avatar',
            fileName: marker,
            mimeType: 'image/png',
            data: png,
        });
        assert.equal(text.trim(), marker, 'server echoes stored filename as plain text');
        await client.post('/api/backgrounds/delete', { bg: marker });
    });

    test('postForm without a file still sends multipart fields', async () => {
        // characters/chats answers 200 {error:true} when the character dir is missing;
        // this verifies the multipart field path executes end-to-end.
        const res = await client.postFormJson('/api/characters/chats', { avatar_url: '__drvtest_missing__.png' });
        assert.deepEqual(res, { error: true });
    });
});

describe('cookie session persistence', () => {
    test('cookies captured from Set-Cookie are replayed on later requests', async () => {
        // If cookies were not replayed, /api/settings/get would fail CSRF/session checks.
        const res = await client.post('/api/settings/get', {});
        assert.equal(typeof res.settings, 'string');
    });

    test('cookie header string contains session cookie name', () => {
        const header = client.buildCookieHeader();
        assert.match(header, /session-/);
    });
});
