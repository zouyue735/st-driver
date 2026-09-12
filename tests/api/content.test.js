import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentApi } from '../../src/api/content.js';
import { StApiError } from '../../src/core/client.js';
import { newClient } from '../helpers.js';

// Live integration tests for ContentApi (Data Bank remote-content import).
// These endpoints download from external whitelisted hosts (chub.ai, janitorai,
// ...). Tests exercise ONLY the validation / error paths so no external card is
// ever fetched into the user's library.
let client, api;

before(async () => {
    client = await newClient();
    api = new ContentApi(client);
});

after(async () => {
    await client?.close();
});

describe('ContentApi.importURL (POST /api/content/importURL)', () => {
    test('missing url throws StApiError 400', async () => {
        await assert.rejects(
            () => api.importURL({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('empty url string throws StApiError 400', async () => {
        await assert.rejects(
            () => api.importURL({ url: '' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('a non-whitelisted host throws StApiError 404', async () => {
        // example.com is not a supported importer and not in whitelistImportDomains
        await assert.rejects(
            () => api.importURL({ url: 'https://example.com/some-character' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('a malformed URL is rejected (4xx/5xx) without importing', async () => {
        await assert.rejects(
            () => api.importURL({ url: 'not a url at all' }),
            err => err instanceof StApiError && err.status >= 400,
        );
    });
});

describe('ContentApi.importUUID (POST /api/content/importUUID)', () => {
    // NOTE: any non-empty value here reaches an external importer (Pygmalion /
    // Janitor / AICC / Perchance / Chub) over the network, so we deliberately
    // only test the parameter-validation paths (no outbound fetch).
    test('missing url throws StApiError 400', async () => {
        await assert.rejects(
            () => api.importUUID({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('empty url string throws StApiError 400', async () => {
        await assert.rejects(
            () => api.importUUID({ url: '' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ContentApi argument handling', () => {
    // The wrapper deliberately does NOT pre-validate `url` — the server answers
    // a descriptive 400, so a no-arg call surfaces as StApiError 400.
    test('importURL() with no arguments throws StApiError 400 (server-validated)', async () => {
        await assert.rejects(
            () => api.importURL(),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('importUUID() with no arguments throws StApiError 400 (server-validated)', async () => {
        await assert.rejects(
            () => api.importUUID(),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('importURL(non-object) throws TypeError', async () => {
        await assert.rejects(() => api.importURL('https://example.com'), /options object/);
    });

    test('importUUID(non-object) throws TypeError', async () => {
        await assert.rejects(() => api.importUUID('some-uuid'), /options object/);
    });
});
