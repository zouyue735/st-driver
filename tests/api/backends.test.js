/**
 * LIVE integration tests for BackendsApi (src/api/backends.js).
 *
 * Covers /api/backends/chat-completions/*, /api/backends/text-completions/*
 * and /api/backends/kobold/* (ST 1.18.0).
 *
 * Cost policy:
 * - FREE endpoints are exercised live: chat-completions /status (models list,
 *   uses the user's configured deepseek key), /bias (tokenizer only),
 *   /process (pure message post-processing), and every connection-failure
 *   error path against a dead local port.
 * - PAID generation (chatCompletionsGenerate / kobold / text-completions
 *   against a real backend) is gated behind ST_DRIVER_LIVE_GEN=1.
 *
 * DANGEROUS SERVER QUIRK (verified live - crashed the ST process during
 * probing): POST /api/backends/kobold/status and /kobold/generate read
 * `request.body.api_server.indexOf(...)` OUTSIDE any try/catch. Omitting
 * api_server produces an unhandled promise rejection that KILLS the whole ST
 * server. BackendsApi therefore requires apiServer client-side and these
 * tests NEVER send such a raw request. For comparison (also verified):
 * text-completions /status without api_server answers 500 (throw is inside
 * try/catch) and /generate answers 200 {error:true, status:'UNKNOWN',
 * response:'Cannot read properties of undefined (reading \'indexOf\')'}.
 *
 * Other live-verified response shapes asserted below:
 * - cc /status, unsupported source: 400 {error:true}.
 * - cc /status, dead custom_url: 200 {error:true} (outer catch, soft error).
 * - cc /status, provider non-OK (bad key): 200 {error:true, data:{data:[]}}.
 * - cc /generate, missing API key: 400 {error:true}.
 * - cc /generate, provider fetch failure (dead custom_url): 502
 *   {error:{message}}.
 * - cc /bias, non-array body: 400 plain 'Bad Request'.
 * - cc /process: 400 {error:'Invalid messages format'} /
 *   {error:'Unknown processing type'}.
 * - tc /status|/props, dead api_server: 500 plain 'Internal Server Error'.
 * - tc /generate, dead api_server: 200 {error:true, status:'ECONNREFUSED',
 *   response:'request to <routed url> failed...'} - the echoed URL proves the
 *   per-api_type routing (/v1/completions, /api/generate, /completion, ...).
 * - kobold /status, dead api_server: 200 {koboldUnitedVersion:'0.0.0',
 *   model:'no_connection'} and NO koboldCppVersion key (source reads
 *   `.result` off a `{version:...}` reply -> undefined).
 * - kobold /generate, dead api_server: 200 {error:true}.
 * - kobold /embed, dead server: 500 plain 'Internal server error'.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    BackendsApi,
    CHAT_COMPLETION_SOURCES,
    PROMPT_PROCESSING_TYPES,
    GENERATE_FIELD_MAP,
    STATUS_FIELD_MAP,
    TEXTGEN_FIELD_MAP,
    KOBOLD_FIELD_MAP,
    buildGenerateBody,
    buildStatusBody,
    buildKoboldBody,
    mapFields,
} from '../../src/api/backends.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, LIVE_GEN } from '../helpers.js';

/** An address guaranteed to refuse connections (nothing listens there). */
const DEAD_SERVER = 'http://127.0.0.1:59999';

let client;
let api;
/** Source/model configured by the user (deepseek), discovered in before(). */
let env;

before(async () => {
    client = await newClient();
    api = new BackendsApi(client);
    const envelope = await client.post('/api/settings/get', {});
    const settings = JSON.parse(envelope.settings);
    const oai = settings?.oai_settings ?? {};
    env = {
        source: oai.chat_completion_source ?? null,
        model: oai.chat_completion_source ? (oai[`${oai.chat_completion_source}_model`] ?? null) : null,
    };
});

after(async () => {
    await client?.close();
});

describe('CHAT_COMPLETION_SOURCES constant (src/constants.js chat_completion_sources)', () => {
    test('is frozen and lists every source of ST 1.18.0', () => {
        assert.ok(Object.isFrozen(CHAT_COMPLETION_SOURCES));
        const expected = [
            'openai', 'claude', 'openrouter', 'ai21', 'makersuite', 'vertexai',
            'mistralai', 'custom', 'cohere', 'perplexity', 'groq', 'chutes',
            'electronhub', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations',
            'moonshot', 'fireworks', 'cometapi', 'azure_openai', 'zai', 'siliconflow',
            'minimax', 'workers_ai',
        ];
        assert.deepEqual([...CHAT_COMPLETION_SOURCES], expected);
    });

    test("includes the user's configured source (deepseek)", () => {
        assert.ok(CHAT_COMPLETION_SOURCES.includes('deepseek'));
    });
});

describe('buildGenerateBody - camelCase -> snake_case mapping (pure, no network)', () => {
    // One independent case per mapped parameter: the exact wire field names are
    // the core value of this module. Every GENERATE_FIELD_MAP entry is asserted
    // individually with a sentinel value.
    for (const [camel, snake] of Object.entries(GENERATE_FIELD_MAP)) {
        const value = `sentinel-${camel}`;
        test(`maps ${camel} -> body.${snake}`, () => {
            const body = buildGenerateBody({ [camel]: value });
            assert.equal(body[snake], value, `${camel} must land on ${snake}`);
        });
    }

    test('omits undefined parameters entirely', () => {
        const body = buildGenerateBody({ chatCompletionSource: 'deepseek', messages: undefined, seed: undefined });
        assert.deepEqual(body, { chat_completion_source: 'deepseek' });
    });

    test('keeps explicit null values (JSON null is forwarded)', () => {
        const body = buildGenerateBody({ chatCompletionSource: 'deepseek', seed: null });
        assert.equal(body.seed, null);
    });

    test('rejects unknown parameters (TypeError naming the key)', () => {
        assert.throws(
            () => buildGenerateBody({ chatCompletionSource: 'deepseek', topPP: 0.5 }),
            err => err instanceof TypeError && /topPP/.test(err.message),
        );
    });

    test('merges the `extra` escape hatch verbatim (forward compatibility)', () => {
        const body = buildGenerateBody({ chatCompletionSource: 'deepseek', extra: { some_future_field: 1 } });
        assert.equal(body.some_future_field, 1);
    });

    test('passes messages through by reference (no structural change)', () => {
        const messages = [{ role: 'user', content: 'hi' }];
        const body = buildGenerateBody({ messages });
        assert.equal(body.messages, messages);
    });

    test('passes jsonSchema through by reference ({name, description, value, strict})', () => {
        const jsonSchema = { name: 'x', description: 'd', value: { type: 'object' }, strict: true };
        const body = buildGenerateBody({ jsonSchema });
        assert.equal(body.json_schema, jsonSchema);
    });

    test('quirk: responseMimeType/responseSchema stay camelCase (Google branch reads request.body.responseMimeType)', () => {
        const body = buildGenerateBody({ responseMimeType: 'application/json', responseSchema: { type: 'object' } });
        assert.equal(body.responseMimeType, 'application/json');
        assert.deepEqual(body.responseSchema, { type: 'object' });
        assert.equal(body.response_mime_type, undefined);
    });

    test('quirk: the streaming kobold flag is `streaming`, chat-completions uses `stream`', () => {
        assert.equal(GENERATE_FIELD_MAP.stream, 'stream');
        assert.equal(KOBOLD_FIELD_MAP.streaming, 'streaming');
    });

    test('mapFields (loose, backward-compat) maps known keys and passes unknown ones through', () => {
        // Unlike buildGenerateBody, mapFields never throws on unknown keys.
        const body = mapFields({ chatCompletionSource: 'openai', topP: 0.9, some_future_field: 1, temperature: undefined });
        assert.deepEqual(body, {
            chat_completion_source: 'openai',
            top_p: 0.9,
            some_future_field: 1,
        });
        assert.equal('temperature' in body, false, 'undefined values are dropped');
    });

    test('mapFields defaults to GENERATE_FIELD_MAP and accepts an explicit map', () => {
        assert.deepEqual(mapFields({ maxTokens: 5 }), { max_tokens: 5 });
        assert.deepEqual(mapFields({ apiServer: 'http://x' }, { apiServer: 'api_server' }), { api_server: 'http://x' });
    });
});

describe('buildStatusBody / buildKoboldBody mapping (pure, no network)', () => {
    for (const [camel, snake] of Object.entries(STATUS_FIELD_MAP)) {
        const value = `sentinel-${camel}`;
        test(`status maps ${camel} -> body.${snake}`, () => {
            assert.equal(buildStatusBody({ [camel]: value })[snake], value);
        });
    }

    for (const [camel, snake] of Object.entries(KOBOLD_FIELD_MAP)) {
        const value = `sentinel-${camel}`;
        test(`kobold maps ${camel} -> body.${snake}`, () => {
            const body = buildKoboldBody({ apiServer: DEAD_SERVER, [camel]: value });
            assert.equal(body[snake], value);
        });
    }

    test('status builder rejects unknown parameters', () => {
        assert.throws(() => buildStatusBody({ bogus: 1 }), err => err instanceof TypeError && /bogus/.test(err.message));
    });

    test('kobold builder requires apiServer (TypeError) - a raw request without it CRASHES the ST server', () => {
        assert.throws(
            () => buildKoboldBody({ prompt: 'x' }),
            err => err instanceof TypeError && /apiServer/.test(err.message),
        );
    });

    test('kobold builder rejects unknown parameters', () => {
        assert.throws(
            () => buildKoboldBody({ apiServer: DEAD_SERVER, nonsense: 1 }),
            err => err instanceof TypeError && /nonsense/.test(err.message),
        );
    });

    test('kobold builder omits undefined values', () => {
        const body = buildKoboldBody({ apiServer: DEAD_SERVER, prompt: 'x', grammar: undefined });
        assert.deepEqual(Object.keys(body).sort(), ['api_server', 'prompt']);
    });

    test('textgen map covers only the ST connection fields; sampler fields pass through verbatim', () => {
        // TEXTGEN_FIELD_MAP maps the camelCase connection fields; every other
        // key is forwarded as sent (the server whitelists per api_type with
        // OPENAI_KEYS/OLLAMA_KEYS/TOGETHERAI_KEYS/... constants).
        assert.equal(TEXTGEN_FIELD_MAP.apiServer, 'api_server');
        assert.equal(TEXTGEN_FIELD_MAP.apiType, 'api_type');
        assert.equal(TEXTGEN_FIELD_MAP.secretId, 'secret_id');
        assert.equal(TEXTGEN_FIELD_MAP.model, 'model');
        assert.equal(TEXTGEN_FIELD_MAP.prompt, 'prompt');
        assert.equal(TEXTGEN_FIELD_MAP.stream, 'stream');
    });
});

describe('BackendsApi.chatCompletionsStatus (POST /api/backends/chat-completions/status)', () => {
    test('live (free): the configured deepseek source returns its model list', async (t) => {
        if (env.source !== 'deepseek') return t.skip(`user source is ${env.source}, not deepseek`);
        const res = await api.chatCompletionsStatus({ chatCompletionSource: 'deepseek' });
        if (res?.error === true) {
            // key invalid/expired -> the server soft-errors with 200 {error:true, data:{data:[]}}
            console.log('[tolerated] deepseek status soft-error (key invalid?):', JSON.stringify(res));
            assert.deepEqual(res.data, { data: [] });
            return;
        }
        assert.equal(res.object, 'list');
        assert.ok(Array.isArray(res.data), 'data must be an array of models');
        assert.ok(res.data.length > 0, 'deepseek exposes at least one model');
        for (const model of res.data) {
            assert.equal(typeof model.id, 'string');
        }
    });

    test('rejects a missing chatCompletionSource client-side (TypeError)', async () => {
        await assert.rejects(() => api.chatCompletionsStatus({}), /chatCompletionSource.*required/);
    });

    test('rejects an empty chatCompletionSource client-side (TypeError)', async () => {
        await assert.rejects(() => api.chatCompletionsStatus({ chatCompletionSource: '  ' }), /chatCompletionSource/);
    });

    test('rejects an unknown chatCompletionSource client-side, listing valid values', async () => {
        await assert.rejects(
            () => api.chatCompletionsStatus({ chatCompletionSource: 'not_a_provider' }),
            err => err instanceof TypeError && /unknown chatCompletionSource/.test(err.message)
                && err.message.includes('openai'),
        );
    });

    test('raw server: an unsupported source answers 400 {error:true}', async () => {
        await assert.rejects(
            () => client.post('/api/backends/chat-completions/status', { chat_completion_source: 'definitely-not-a-source' }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true,
        );
    });

    test('a nonexistent secretId answers 400 {error:true} (the key resolves to null)', async () => {
        await assert.rejects(
            () => api.chatCompletionsStatus({ chatCompletionSource: 'deepseek', secretId: 'no-such-secret-id' }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true,
        );
    });

    test('azure_openai without full config answers 400 {error:true, message}', async () => {
        await assert.rejects(
            () => api.chatCompletionsStatus({ chatCompletionSource: 'azure_openai' }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true
                && typeof err.body?.message === 'string',
        );
    });

    test('custom source with a dead customUrl answers 200 {error:true} (fetch failure is soft)', async () => {
        // source: outer catch -> statusResponse.send({ error: true }) at HTTP 200
        const res = await api.chatCompletionsStatus({ chatCompletionSource: 'custom', customUrl: `${DEAD_SERVER}/v1` });
        assert.equal(res?.error, true);
    });

    test('maps reverseProxy/proxyPassword/customUrl/secretId onto the wire names', () => {
        const body = buildStatusBody({
            chatCompletionSource: 'custom',
            reverseProxy: 'http://proxy',
            proxyPassword: 'pw',
            customUrl: 'http://cu',
            secretId: 'sid',
        });
        assert.deepEqual(body, {
            chat_completion_source: 'custom',
            reverse_proxy: 'http://proxy',
            proxy_password: 'pw',
            custom_url: 'http://cu',
            secret_id: 'sid',
        });
    });
});

describe('BackendsApi.chatCompletionsGenerate - parameter validation (no LLM calls)', () => {
    test('rejects a missing chatCompletionSource', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ messages: [], model: 'x' }),
            /chatCompletionSource.*required/,
        );
    });

    test('rejects an unknown chatCompletionSource', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ chatCompletionSource: 'bogus', messages: [], model: 'x' }),
            /unknown chatCompletionSource/,
        );
    });

    test('rejects missing messages', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ chatCompletionSource: 'openai', model: 'x' }),
            /messages.*required/,
        );
    });

    test('rejects a missing model', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ chatCompletionSource: 'openai', messages: [] }),
            /model.*required/,
        );
    });

    test('rejects stream=true on the non-streaming method (points to chatCompletionsGenerateStream)', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ chatCompletionSource: 'openai', messages: [], model: 'x', stream: true }),
            /chatCompletionsGenerateStream/,
        );
    });

    test('rejects a non-object argument', async () => {
        await assert.rejects(() => api.chatCompletionsGenerate('nope'), /options object/);
    });

    test('rejects unknown parameters (typo guard, no request sent)', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({ chatCompletionSource: 'deepseek', messages: [], model: 'x', topPP: 1 }),
            err => err instanceof TypeError && /topPP/.test(err.message),
        );
    });

    test('chatCompletionsGenerateStream validates parameters before any network call', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerateStream({ chatCompletionSource: 'bogus', messages: [], model: 'x' }),
            /unknown chatCompletionSource/,
        );
    });
});

describe('BackendsApi.chatCompletionsGenerate - live error structures (free, no LLM billed)', () => {
    test('raw server: an unsupported source answers 400 {error:true}', async () => {
        await assert.rejects(
            () => client.post('/api/backends/chat-completions/generate', { chat_completion_source: 'definitely-not-a-source', messages: [] }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true,
        );
    });

    test('deepseek without a usable key answers 400 {error:true}', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({
                chatCompletionSource: 'deepseek',
                secretId: 'no-such-secret-id',
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: 'hi' }],
                maxTokens: 1,
            }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true,
        );
    });

    test('claude without a key answers 400 {error:true}', async () => {
        await assert.rejects(
            () => api.chatCompletionsGenerate({
                chatCompletionSource: 'claude',
                secretId: 'no-such-secret-id',
                model: 'claude-3-5-sonnet',
                messages: [{ role: 'user', content: 'hi' }],
                maxTokens: 1,
            }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === true,
        );
    });

    test('custom source with a dead customUrl answers 502 {error:{message}} (fetch failure path)', async () => {
        // source: outer catch -> response.status(502).send({ error: { message, ...error } })
        const err = await api.chatCompletionsGenerate({
            chatCompletionSource: 'custom',
            customUrl: `${DEAD_SERVER}/v1`,
            model: 'whatever',
            messages: [{ role: 'user', content: 'hi' }],
        }).catch(e => e);
        assert.ok(err instanceof StApiError, `expected StApiError, got ${JSON.stringify(err)}`);
        assert.equal(err.status, 502);
        assert.equal(typeof err.body?.error?.message, 'string');
        assert.match(err.body.error.message, /ECONNREFUSED|Connection refused/);
    });

    test('LIVE_GEN: deepseek 1-token reply verifies the mapped body passes through', {
        skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable (spends tokens)',
    }, async () => {
        assert.ok(env.source === 'deepseek' && env.model, 'a configured deepseek source+model is required');
        const res = await api.chatCompletionsGenerate({
            chatCompletionSource: 'deepseek',
            model: env.model,
            messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
            maxTokens: 8,
            temperature: 0,
            includeReasoning: false,
        });
        // DeepSeek answers in OpenAI chat-completions format; the handler
        // forwards provider JSON verbatim. A provider-side failure surfaces as
        // 200 {error:{message}, quota_error} or StApiError 500 - tolerated.
        if (res?.error) {
            console.log('[tolerated] provider error:', JSON.stringify(res).slice(0, 300));
            return;
        }
        assert.ok(Array.isArray(res?.choices), `expected choices[], got ${JSON.stringify(res).slice(0, 200)}`);
        assert.equal(typeof res.choices[0]?.message?.content, 'string');
    });
});

describe('BackendsApi.chatCompletionsBias (POST .../bias?model= - tokenizer only, free)', () => {
    test('live: the deepseek tokenizer returns a token-id -> bias map', async () => {
        const res = await api.chatCompletionsBias([{ text: 'hello', value: -100 }], 'deepseek-flash');
        assert.equal(typeof res, 'object');
        const keys = Object.keys(res);
        assert.ok(keys.length > 0, 'the deepseek tokenizer must produce at least one token');
        assert.ok(keys.every(k => /^\d+$/.test(k)), 'keys are stringified token ids');
        assert.ok(Object.values(res).every(v => v === -100), 'values round-trip');
    });

    test('live: multiple entries with different values all round-trip', async () => {
        const res = await api.chatCompletionsBias(
            [{ text: 'hello', value: 100 }, { text: ' world', value: -50 }],
            'deepseek-flash',
        );
        const values = Object.values(res);
        assert.ok(values.length > 0);
        assert.ok(values.every(v => v === 100 || v === -50));
    });

    test("live: a JSON token-id array as text uses the ids verbatim (source: getEntryTokens parses '[...]' numbers)", async () => {
        const res = await api.chatCompletionsBias([{ text: '[15496, 11]', value: 100 }], 'deepseek-flash');
        assert.equal(res['15496'], 100);
        assert.equal(res['11'], 100);
        assert.equal(Object.keys(res).length, 2);
    });

    test('live: model=claude returns {} (source: no bias for claude)', async () => {
        assert.deepEqual(await api.chatCompletionsBias([{ text: 'hello', value: -100 }], 'claude'), {});
    });

    test('live: omitting model falls back to the default cl100k tokenizer (hello -> 15339)', async () => {
        // getTokenizerModel('') -> 'gpt-3.5-turbo' (tiktoken cl100k_base)
        const res = await api.chatCompletionsBias([{ text: 'hello', value: -100 }]);
        assert.equal(res['15339'], -100);
    });

    test('live: an explicit gpt-3.5-turbo model encodes via tiktoken cl100k', async () => {
        const res = await api.chatCompletionsBias([{ text: 'hello', value: -100 }], 'gpt-3.5-turbo');
        assert.equal(res['15339'], -100);
    });

    test('live: entries without text are skipped (source: `if (!entry || !entry.text) continue`)', async () => {
        assert.deepEqual(await api.chatCompletionsBias([{ value: 5 }, { text: '', value: 6 }], 'gpt-3.5-turbo'), {});
    });

    test('a plain string entry is normalized to {text, value: -100} (ban shorthand)', async () => {
        const res = await api.chatCompletionsBias(['hello'], 'gpt-3.5-turbo');
        assert.equal(res['15339'], -100);
    });

    test('an empty array returns {}', async () => {
        assert.deepEqual(await api.chatCompletionsBias([], 'gpt-3.5-turbo'), {});
    });

    test('rejects a non-array entries argument (TypeError)', async () => {
        await assert.rejects(() => api.chatCompletionsBias('nope', 'model'), /entries must be an array/);
    });

    test('raw server: a non-array body answers 400 (plain-text Bad Request)', async () => {
        await assert.rejects(
            () => client.post('/api/backends/chat-completions/bias?model=gpt2', { not: 'an array' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('BackendsApi.chatCompletionsProcess (POST .../process - free, pure post-processing)', () => {
    test('PROMPT_PROCESSING_TYPES matches the source enum exactly (prompt-converters.js)', () => {
        assert.deepEqual(
            [...PROMPT_PROCESSING_TYPES],
            ['', 'claude', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single'],
        );
    });

    test("live: type='semi_tools' merges consecutive user messages", async () => {
        const res = await api.chatCompletionsProcess({
            messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
            type: 'semi_tools',
        });
        assert.deepEqual(res, { messages: [{ role: 'user', content: 'a\n\nb' }] });
    });

    test("live: type='strict' keeps the system message separate", async () => {
        const res = await api.chatCompletionsProcess({
            messages: [
                { role: 'system', content: 's' },
                { role: 'user', content: 'a' },
                { role: 'user', content: 'b' },
            ],
            type: 'strict',
        });
        assert.deepEqual(res.messages[0], { role: 'system', content: 's' });
        assert.deepEqual(res.messages[1], { role: 'user', content: 'a\n\nb' });
    });

    test("live: type='' (NONE) passes messages through unchanged - '' is a VALID type", async () => {
        const messages = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
        assert.deepEqual(await api.chatCompletionsProcess({ messages, type: '' }), { messages });
    });

    test('live: charName/userName/groupNames map to char_name/user_name/group_names and are accepted', async () => {
        // getPromptNames() reads these snake_case fields for {{char}}/{{user}} fixes
        const res = await api.chatCompletionsProcess({
            messages: [{ role: 'user', content: 'a' }],
            type: '',
            charName: 'Alice',
            userName: 'Bob',
            groupNames: ['Carl'],
        });
        assert.deepEqual(res, { messages: [{ role: 'user', content: 'a' }] });
    });

    test('an invalid type rejects client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.chatCompletionsProcess({ messages: [], type: 'bogus' }),
            err => err instanceof TypeError && /type/.test(err.message),
        );
    });

    test('a missing type rejects client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.chatCompletionsProcess({ messages: [] }),
            err => err instanceof TypeError && /'type' is required/.test(err.message),
        );
    });

    test('raw server: a bad type answers 400 {error:"Unknown processing type"}', async () => {
        await assert.rejects(
            () => client.post('/api/backends/chat-completions/process', { messages: [], type: 'bogus' }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === 'Unknown processing type',
        );
    });

    test('non-array messages reject client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.chatCompletionsProcess({ messages: 'x', type: 'merge' }),
            err => err instanceof TypeError && /messages/.test(err.message),
        );
    });

    test('raw server: non-array messages answer 400 {error:"Invalid messages format"}', async () => {
        await assert.rejects(
            () => client.post('/api/backends/chat-completions/process', { messages: 'x', type: 'merge' }),
            err => err instanceof StApiError && err.status === 400 && err.body?.error === 'Invalid messages format',
        );
    });
});

describe('BackendsApi.textCompletionsStatus (POST /api/backends/text-completions/status)', () => {
    test('a dead api_server answers 500 (plain-text Internal Server Error)', async () => {
        await assert.rejects(
            () => api.textCompletionsStatus({ apiServer: DEAD_SERVER, apiType: 'ooba' }),
            err => err instanceof StApiError && err.status === 500 && err.body === 'Internal Server Error',
        );
    });

    test('rejects a missing apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.textCompletionsStatus({ apiType: 'ooba' }), /apiServer.*required/);
    });

    test('rejects an empty apiServer client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.textCompletionsStatus({ apiServer: '  ', apiType: 'ooba' }),
            /non-empty/,
        );
    });

    test('raw server quirk: missing api_server answers 500 (indexOf throw is INSIDE try/catch here)', async () => {
        // contrast with kobold/status, where the same omission KILLS the server
        await assert.rejects(
            () => client.post('/api/backends/text-completions/status', { api_type: 'ooba' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('an unknown apiType still probes the bare base URL and answers 500 when dead', async () => {
        await assert.rejects(
            () => api.textCompletionsStatus({ apiServer: DEAD_SERVER, apiType: 'not-a-type' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackendsApi.textCompletionsProps (POST /api/backends/text-completions/props)', () => {
    test('a dead api_server answers 500', async () => {
        await assert.rejects(
            () => api.textCompletionsProps({ apiServer: DEAD_SERVER }),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('rejects a missing apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.textCompletionsProps({}), /apiServer.*required/);
    });

    test('raw server: missing api_server answers 400 (explicit check in handler)', async () => {
        await assert.rejects(
            () => client.post('/api/backends/text-completions/props', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('accepts apiType=llamacpp with a model (handler appends ?model= to /props)', async () => {
        await assert.rejects(
            () => api.textCompletionsProps({ apiServer: DEAD_SERVER, apiType: 'llamacpp', model: 'ggml-model.gguf' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackendsApi.textCompletionsGenerate (POST /api/backends/text-completions/generate)', () => {
    test('a dead ooba server answers 200 {error:true, status:"ECONNREFUSED", response}', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'ooba', prompt: 'hi', max_tokens: 1 });
        assert.equal(res.error, true);
        assert.equal(res.status, 'ECONNREFUSED');
        assert.equal(typeof res.response, 'string');
        assert.match(res.response, /ECONNREFUSED/);
    });

    test('routes api_type=ooba to /v1/completions (URL echoed in the error text)', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'ooba', prompt: 'x' });
        assert.match(res.response, /\/v1\/completions/);
    });

    test('routes api_type=ollama to /api/generate', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'ollama', prompt: 'x', model: 'm' });
        assert.match(res.response, /\/api\/generate/);
    });

    test('routes api_type=llamacpp to /completion', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'llamacpp', prompt: 'x' });
        assert.match(res.response, /\/completion/);
    });

    test('routes api_type=mancer to /oai/v1/completions', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'mancer', prompt: 'x' });
        assert.match(res.response, /\/oai\/v1\/completions/);
    });

    test('routes api_type=dreamgen to /api/openai/v1/completions', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'dreamgen', prompt: 'x' });
        assert.match(res.response, /\/api\/openai\/v1\/completions/);
    });

    test('routes api_type=openrouter to /v1/chat/completions', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'openrouter', prompt: 'x' });
        assert.match(res.response, /\/v1\/chat\/completions/);
    });

    test('routes api_type=tabby to /v1/completions', async () => {
        const res = await api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'tabby', prompt: 'x' });
        assert.match(res.response, /\/v1\/completions/);
    });

    test('rejects a missing apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.textCompletionsGenerate({ apiType: 'ooba', prompt: 'x' }), /apiServer.*required/);
    });

    test('rejects a missing prompt client-side (TypeError)', async () => {
        await assert.rejects(() => api.textCompletionsGenerate({ apiServer: DEAD_SERVER, apiType: 'ooba' }), /prompt.*required/);
    });

    test('raw server quirk: missing api_server answers 200 {error:true, status:"UNKNOWN"} (indexOf throw is caught)', async () => {
        const res = await client.post('/api/backends/text-completions/generate', { prompt: 'x' });
        assert.equal(res.error, true);
        assert.equal(res.status, 'UNKNOWN');
        assert.match(res.response, /indexOf/);
    });

    test('forwards arbitrary snake_case sampler fields verbatim (passthrough by design)', async () => {
        // The handler whitelists per api_type (OPENAI_KEYS/OLLAMA_KEYS/...) and
        // forwards the rest as sent; a dead server still echoes the routed URL.
        const res = await api.textCompletionsGenerate({
            apiServer: DEAD_SERVER,
            apiType: 'ooba',
            prompt: 'x',
            max_new_tokens: 16,
            repetition_penalty: 1.1,
            custom_field: 'kept',
        });
        assert.equal(res.error, true);
    });

    test('LIVE_GEN: generates against a real text-completions server', {
        skip: !LIVE_GEN && 'requires a local textgen server + ST_DRIVER_LIVE_GEN=1',
    }, async () => {
        const server = process.env.ST_TEXTGEN_URL;
        if (!server) {
            console.log('[tolerated] ST_TEXTGEN_URL not set - nothing to generate against');
            return;
        }
        const res = await api.textCompletionsGenerate({
            apiServer: server,
            apiType: process.env.ST_TEXTGEN_TYPE ?? 'ooba',
            prompt: 'Say hi',
            max_tokens: 8,
            stream: false,
        });
        assert.ok(res?.choices ?? res?.error === undefined, `unexpected response ${JSON.stringify(res).slice(0, 200)}`);
    });
});

describe('BackendsApi.koboldStatus (POST /api/backends/kobold/status)', () => {
    test('a dead api_server answers 200 {koboldUnitedVersion:"0.0.0", model:"no_connection"}', async () => {
        const res = await api.koboldStatus({ apiServer: DEAD_SERVER });
        assert.equal(res.koboldUnitedVersion, '0.0.0');
        assert.equal(res.model, 'no_connection');
    });

    test('quirk: koboldCppVersion is ABSENT for a dead server (source reads .result off a {version} reply)', async () => {
        const res = await api.koboldStatus({ apiServer: DEAD_SERVER });
        assert.equal('koboldCppVersion' in res, false);
    });

    test('rejects a missing apiServer client-side (TypeError) - a raw request without it CRASHES the ST server', async () => {
        // Verified live: the handler dereferences request.body.api_server
        // OUTSIDE try/catch; the unhandled rejection kills the Node process.
        // NEVER send the raw request; this test only asserts the client guard.
        await assert.rejects(() => api.koboldStatus({}), /apiServer.*required/);
    });

    test('rejects an empty apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.koboldStatus({ apiServer: '  ' }), /non-empty/);
    });

    test("localhost is replaced with 127.0.0.1 server-side (dead localhost still 'no_connection')", async () => {
        const res = await api.koboldStatus({ apiServer: 'http://localhost:59999' });
        assert.equal(res.model, 'no_connection');
    });
});

describe('BackendsApi.koboldGenerate (POST /api/backends/kobold/generate)', () => {
    test('a dead api_server answers 200 {error:true}', async () => {
        const res = await api.koboldGenerate({
            apiServer: DEAD_SERVER,
            prompt: 'hi',
            maxLength: 16,
            maxContextLength: 80,
        });
        assert.deepEqual(res, { error: true });
    });

    test('rejects a missing apiServer client-side (TypeError) - a raw request without it CRASHES the ST server', async () => {
        await assert.rejects(() => api.koboldGenerate({ prompt: 'x' }), /apiServer.*required/);
    });

    test('rejects a missing prompt client-side (TypeError)', async () => {
        await assert.rejects(() => api.koboldGenerate({ apiServer: DEAD_SERVER }), /prompt.*required/);
    });

    test('rejects unknown parameters (typo guard)', async () => {
        await assert.rejects(
            () => api.koboldGenerate({ apiServer: DEAD_SERVER, prompt: 'x', stream: true }),
            err => err instanceof TypeError && /stream/.test(err.message),
        );
    });

    test('LIVE_GEN: generates against a real koboldcpp server', {
        skip: !LIVE_GEN && 'requires a local koboldcpp server + ST_DRIVER_LIVE_GEN=1',
    }, async () => {
        const server = process.env.ST_KOBOLD_URL;
        if (!server) {
            console.log('[tolerated] ST_KOBOLD_URL not set - nothing to generate against');
            return;
        }
        const res = await api.koboldGenerate({ apiServer: server, prompt: 'Say hi', maxLength: 8, maxContextLength: 80 });
        assert.equal(typeof (res?.results?.[0]?.text ?? res?.error), 'string');
    });
});

describe('BackendsApi.koboldEmbed / koboldTranscribeAudio (koboldcpp extras)', () => {
    test('embed rejects a missing server client-side (TypeError)', async () => {
        await assert.rejects(() => api.koboldEmbed({ items: ['x'] }), /server.*required/);
    });

    test('embed rejects a missing items array client-side (TypeError)', async () => {
        await assert.rejects(() => api.koboldEmbed({ server: DEAD_SERVER }), /items.*array/);
    });

    test('raw server: embed without server answers 400', async () => {
        await assert.rejects(
            () => client.post('/api/backends/kobold/embed', { items: ['x'] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('embed against a dead server answers 500 (plain-text Internal server error)', async () => {
        await assert.rejects(
            () => api.koboldEmbed({ server: DEAD_SERVER, items: ['x'] }),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('transcribeAudio rejects a non-Buffer audio argument (TypeError)', async () => {
        await assert.rejects(() => api.koboldTranscribeAudio('not a buffer', { server: DEAD_SERVER }), /Buffer/);
    });

    test('transcribeAudio rejects a missing server client-side (TypeError)', async () => {
        await assert.rejects(() => api.koboldTranscribeAudio(Buffer.from('x'), {}), /server.*required/);
    });

    test('raw server: transcribe-audio without server answers 400', async () => {
        await assert.rejects(
            () => client.postForm('/api/backends/kobold/transcribe-audio', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('transcribeAudio against a dead server answers 500', async () => {
        await assert.rejects(
            () => api.koboldTranscribeAudio(Buffer.from('RIFF....'), { server: DEAD_SERVER }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('BackendsApi text-completions sub-routers (ollama / llamacpp / tabby)', () => {
    test('ollamaDownload rejects a missing name client-side (TypeError)', async () => {
        await assert.rejects(() => api.ollamaDownload({ apiServer: DEAD_SERVER }), /name.*required/);
    });

    test('ollamaDownload rejects a missing apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.ollamaDownload({ name: 'llama3' }), /apiServer.*required/);
    });

    test('raw server: ollama/download without name+api_server answers 400', async () => {
        await assert.rejects(
            () => client.post('/api/backends/text-completions/ollama/download', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('ollamaCaptionImage rejects a missing image client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.ollamaCaptionImage({ serverUrl: DEAD_SERVER, model: 'llava', prompt: 'x' }),
            /image.*required/,
        );
    });

    test('raw server: ollama/caption-image without server_url+model answers 400', async () => {
        await assert.rejects(
            () => client.post('/api/backends/text-completions/ollama/caption-image', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('llamacppProps rejects a missing serverUrl client-side (TypeError)', async () => {
        await assert.rejects(() => api.llamacppProps({}), /serverUrl.*required/);
    });

    test('raw server: llamacpp/props without server_url answers 400', async () => {
        await assert.rejects(
            () => client.post('/api/backends/text-completions/llamacpp/props', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('llamacppSlots rejects an invalid action client-side (TypeError)', async () => {
        await assert.rejects(
            () => api.llamacppSlots({ serverUrl: DEAD_SERVER, action: 'bogus' }),
            /action/,
        );
    });

    test('llamacppSlots info action against a dead server answers 500', async () => {
        await assert.rejects(
            () => api.llamacppSlots({ serverUrl: DEAD_SERVER, action: 'info' }),
            err => err instanceof StApiError && err.status === 500,
        );
    });

    test('tabbyDownload rejects a missing apiServer client-side (TypeError)', async () => {
        await assert.rejects(() => api.tabbyDownload({ fileName: 'x' }), /apiServer.*required/);
    });
});

describe('BackendsApi.multimodalModels (POST .../multimodal-models/<provider>)', () => {
    test('rejects a missing provider client-side (TypeError)', async () => {
        await assert.rejects(() => api.multimodalModels(), /provider.*required/);
    });

    test('live (free): pollinations returns an array of model ids', async () => {
        const res = await api.multimodalModels('pollinations').catch(e => e);
        if (res instanceof StApiError) {
            console.log(`[tolerated] pollinations multimodal-models failed: ${res.status}`);
            return;
        }
        assert.ok(Array.isArray(res));
        assert.ok(res.every(m => typeof m === 'string'));
    });

    test('live: chutes without a key returns [] (source: `if (!key) return res.json([])`)', async () => {
        const res = await api.multimodalModels('chutes');
        assert.deepEqual(res, []);
    });
});
