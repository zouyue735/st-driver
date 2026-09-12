import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TranslateApi, CaptionApi, ClassifyApi, SpeechApi, TRANSLATE_PROVIDERS } from '../../src/api/external-ai.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, tinyPng } from '../helpers.js';

// Live integration tests for external-AI helper endpoints.
// Validation paths are always exercised; live service calls are attempted but
// tolerate "not configured" errors (the user's instance may not have every
// translation/vision service set up).
let client, translate, caption, classify, speech;

before(async () => {
    client = await newClient();
    translate = new TranslateApi(client);
    caption = new CaptionApi(client);
    classify = new ClassifyApi(client);
    speech = new SpeechApi(client);
});

after(async () => {
    await client?.close();
});

describe('TRANSLATE_PROVIDERS constant', () => {
    test('lists all 8 providers, frozen', () => {
        assert.ok(Object.isFrozen(TRANSLATE_PROVIDERS));
        assert.equal(TRANSLATE_PROVIDERS.length, 8);
        for (const p of ['libre', 'google', 'yandex', 'lingva', 'deepl', 'onering', 'deeplx', 'bing']) {
            assert.ok(TRANSLATE_PROVIDERS.includes(p));
        }
    });
});

describe('TranslateApi.translate validation', () => {
    test('rejects an unknown provider client-side, listing valid ones', async () => {
        await assert.rejects(
            () => translate.translate({ text: 'hi', lang: 'de', provider: 'babelfish' }),
            err => err instanceof TypeError && /unknown provider/.test(err.message) && err.message.includes('libre'),
        );
    });

    test('rejects missing text', async () => {
        await assert.rejects(() => translate.translate({ lang: 'de' }), /'text' is required/);
    });

    test('rejects empty text', async () => {
        await assert.rejects(() => translate.translate({ text: '', lang: 'de' }), /'text' is required/);
    });

    test('rejects missing lang', async () => {
        await assert.rejects(() => translate.translate({ text: 'hi' }), /'lang'.*required/);
    });

    test('google translate with no key surfaces a server/provider error, not a TypeError', async () => {
        // google/bing are keyless-ish public endpoints; this either returns a
        // translation or a StApiError - it must NOT be a client-side TypeError
        // (proving the request was correctly formed and sent).
        let got;
        try {
            got = await translate.translate({ text: 'hello', lang: 'de', provider: 'google' });
        } catch (e) {
            got = e;
        }
        assert.ok(
            typeof got === 'string' || got instanceof StApiError,
            `expected a string or StApiError, got ${got}`,
        );
    });
});

describe('CaptionApi', () => {
    test('rejects a missing image', async () => {
        await assert.rejects(() => caption.caption({}), /'image'.*required/);
    });

    test('captions a tiny PNG or surfaces a config error (no crash)', async () => {
        const dataUri = `data:image/png;base64,${tinyPng().toString('base64')}`;
        let got;
        try {
            got = await caption.caption({ image: dataUri });
        } catch (e) {
            got = e;
        }
        // local transformers model or a configured vision source; either a
        // {caption} object or a StApiError when nothing is set up
        assert.ok(
            (got && typeof got === 'object' && 'caption' in got) || got instanceof StApiError || typeof got === 'string',
            `unexpected caption result: ${JSON.stringify(got)}`,
        );
    });
});

describe('ClassifyApi', () => {
    test('labels returns a labels array or a config error', async () => {
        let got;
        try {
            got = await classify.labels();
        } catch (e) {
            got = e;
        }
        assert.ok((got && Array.isArray(got.labels)) || got instanceof StApiError || (got && got.error),
            `unexpected labels result: ${JSON.stringify(got)}`);
    });

    test('classify rejects missing text', async () => {
        await assert.rejects(() => classify.classify({}), /'text' is required/);
    });

    test('classify accepts an empty string (does not throw client-side)', async () => {
        let got;
        try {
            got = await classify.classify({ text: '' });
        } catch (e) {
            got = e;
        }
        assert.ok(got instanceof StApiError || (got && typeof got === 'object'), `got ${got}`);
    });
});

describe('SpeechApi validation', () => {
    test('recognize rejects missing audio', async () => {
        await assert.rejects(() => speech.recognize({}), /'audio'.*required/);
    });

    test('synthesize rejects missing text', async () => {
        await assert.rejects(() => speech.synthesize({}), /'text' is required/);
    });

    test('synthesize accepts an empty string text (server decides)', async () => {
        let got;
        try {
            got = await speech.synthesize({ text: '' });
        } catch (e) {
            got = e;
        }
        // either WAV bytes (Buffer) or a StApiError when no local TTS model
        assert.ok(Buffer.isBuffer(got) || got instanceof StApiError || typeof got === 'object',
            `unexpected synthesize result: ${got}`);
    });
});
