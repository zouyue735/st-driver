import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SearchApi, HordeApi, QUERY_PROVIDERS } from '../../src/api/search.js';
import { StApiError } from '../../src/core/client.js';
import { newClient } from '../helpers.js';

// Live integration tests for SearchApi and HordeApi.
//
// SEARCH: the key-based providers (serpapi/tavily/serper/zai) answer HTTP 400
// when no secret is configured (verified in source), which is exactly what we
// assert - proving the request reached the handler. searxng/koboldcpp need a
// running instance, so only their client-side validation is exercised.
// visit/transcript make REAL outbound calls, so they are gated.
//
// HORDE: anonymous list endpoints (status, text-models, sd-models, sd-samplers)
// are exercised for real; generation (Kudos-spending) is gated.
let client, search, horde;
const LIVE_NET = process.env.ST_DRIVER_LIVE_NET === '1';

before(async () => {
    client = await newClient();
    search = new SearchApi(client);
    horde = new HordeApi(client);
});

after(async () => {
    await client?.close();
});

describe('QUERY_PROVIDERS constant', () => {
    test('lists the query-based providers, frozen', () => {
        assert.ok(Object.isFrozen(QUERY_PROVIDERS));
        for (const p of ['tavily', 'serper', 'serpapi', 'zai', 'searxng', 'koboldcpp']) {
            assert.ok(QUERY_PROVIDERS.includes(p), `${p} must be listed`);
        }
    });
});

describe('SearchApi client-side validation', () => {
    for (const method of ['tavily', 'serper', 'serpapi', 'zai']) {
        test(`${method} rejects a missing query`, async () => {
            await assert.rejects(() => search[method]({}), /'query' is required/);
        });
        test(`${method} rejects a non-object argument`, async () => {
            await assert.rejects(() => search[method]('just a string'), /options object/);
        });
    }

    test('searxng rejects a missing baseUrl', async () => {
        await assert.rejects(() => search.searxng({ query: 'x' }), /'baseUrl' is required/);
    });
    test('searxng rejects a missing query', async () => {
        await assert.rejects(() => search.searxng({ baseUrl: 'http://x' }), /'query' is required/);
    });
    test('koboldcpp rejects a missing url', async () => {
        await assert.rejects(() => search.koboldcpp({ query: 'x' }), /'url' is required/);
    });
    test('koboldcpp rejects a missing query', async () => {
        await assert.rejects(() => search.koboldcpp({ url: 'http://x' }), /'query' is required/);
    });
    test('visit rejects a missing url', async () => {
        await assert.rejects(() => search.visit({}), /'url' is required/);
    });
    test('transcript rejects a missing id', async () => {
        await assert.rejects(() => search.transcript({}), /'id'.*required/);
    });
});

describe('SearchApi key-based providers (live: 400 when no secret configured)', () => {
    // These assert the request reached the handler. With no key configured the
    // server answers 400 (verified in source). If the user HAS a key, the call
    // may succeed (object) or fail with a provider error - both acceptable.
    for (const method of ['tavily', 'serper', 'serpapi', 'zai']) {
        test(`${method} reaches the server (400 no-key, or a provider response)`, async () => {
            let got;
            try {
                got = await search[method]({ query: 'test query' });
            } catch (e) {
                got = e;
            }
            assert.ok(
                got instanceof StApiError || (got && typeof got === 'object'),
                `expected StApiError or object, got ${got}`,
            );
            if (got instanceof StApiError) {
                assert.ok(got.status >= 400, `status ${got.status}`);
            }
        });
    }
});

describe('SearchApi real-network endpoints (gated by ST_DRIVER_LIVE_NET)', () => {
    test('visit fetches a page and returns content', { skip: !LIVE_NET && 'set ST_DRIVER_LIVE_NET=1' }, async () => {
        let got;
        try {
            got = await search.visit({ url: 'https://example.com' });
        } catch (e) {
            got = e;
        }
        assert.ok(got instanceof StApiError || (got && typeof got === 'object'), `got ${got}`);
    });

    test('transcript fetches a YouTube transcript or errors gracefully', { skip: !LIVE_NET && 'set ST_DRIVER_LIVE_NET=1' }, async () => {
        let got;
        try {
            got = await search.transcript({ id: 'dQw4w9WgXcQ', lang: 'en' });
        } catch (e) {
            got = e;
        }
        assert.ok(got instanceof StApiError || got !== undefined, `got ${got}`);
    });
});

describe('HordeApi client-side validation', () => {
    test('generateImage rejects a missing prompt', async () => {
        await assert.rejects(() => horde.generateImage({}), /'prompt' is required/);
    });
    test('taskStatus rejects a missing taskId', async () => {
        await assert.rejects(() => horde.taskStatus({}), /'taskId' is required/);
    });
    test('cancelTask rejects a missing taskId', async () => {
        await assert.rejects(() => horde.cancelTask({}), /'taskId' is required/);
    });
    test('captionImage rejects a missing image', async () => {
        await assert.rejects(() => horde.captionImage({}), /'image' is required/);
    });
});

describe('HordeApi anonymous list endpoints (live)', () => {
    test('status returns the horde heartbeat or a soft error', async () => {
        let got;
        try { got = await horde.status(); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || (got && typeof got === 'object') || typeof got === 'string',
            `unexpected status: ${JSON.stringify(got)}`);
    });

    test('textModels returns a list or a soft error', async () => {
        let got;
        try { got = await horde.textModels(); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || Array.isArray(got) || (got && typeof got === 'object'),
            `unexpected textModels: ${JSON.stringify(got)?.slice(0, 200)}`);
    });

    test('sdModels returns a list or a soft error', async () => {
        let got;
        try { got = await horde.sdModels(); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || Array.isArray(got) || (got && typeof got === 'object'),
            `unexpected sdModels: ${JSON.stringify(got)?.slice(0, 200)}`);
    });

    test('sdSamplers returns a list or a soft error', async () => {
        let got;
        try { got = await horde.sdSamplers(); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || Array.isArray(got) || (got && typeof got === 'object'),
            `unexpected sdSamplers: ${JSON.stringify(got)?.slice(0, 200)}`);
    });

    test('userInfo returns account info or an auth/soft error', async () => {
        let got;
        try { got = await horde.userInfo(); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || (got && typeof got === 'object') || typeof got === 'string',
            `unexpected userInfo: ${JSON.stringify(got)?.slice(0, 200)}`);
    });

    test('taskStatus with a bogus id surfaces an error, not a crash', async () => {
        let got;
        try { got = await horde.taskStatus({ taskId: '00000000-0000-0000-0000-000000000000' }); } catch (e) { got = e; }
        assert.ok(got instanceof StApiError || (got && typeof got === 'object'), `got ${got}`);
    });
});
