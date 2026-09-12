/**
 * LIVE INTEGRATION tests for TokenizersApi against a running SillyTavern.
 *
 * LOSSLESS PRINCIPLE: tokenizer endpoints are pure functions over the request
 * body - no server state is written, so nothing needs restoring.
 *
 * Model list verified against ST src/endpoints/tokenizers.js routes:
 *  - sentencepiece: llama, nerdstash, nerdstash_v2, mistral, yi, gemma, jamba
 *  - tiktoken:      gpt2
 *  - web:           claude, llama3, qwen2, command-r, command-a, nemo, deepseek
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenizersApi, TOKENIZER_MODELS, SENTENCEPIECE_MODELS, TIKTOKEN_MODELS, WEB_MODELS } from '../../src/api/tokenizers.js';
import { newClient } from '../helpers.js';

let client;
let api;

before(async () => {
    client = await newClient();
    api = new TokenizersApi(client);
});

after(async () => {
    await client?.close();
});

describe('model lists', () => {
    test('TOKENIZER_MODELS contains the 15 routed models', () => {
        assert.deepEqual([...TOKENIZER_MODELS].sort(), [
            'claude', 'command-a', 'command-r', 'deepseek', 'gemma', 'gpt2',
            'jamba', 'llama', 'llama3', 'mistral', 'nemo', 'nerdstash',
            'nerdstash_v2', 'qwen2', 'yi',
        ]);
    });

    test('category lists partition TOKENIZER_MODELS', () => {
        const all = [...SENTENCEPIECE_MODELS, ...TIKTOKEN_MODELS, ...WEB_MODELS].sort();
        assert.deepEqual(all, [...TOKENIZER_MODELS].sort());
    });
});

describe('encode(model, text)', () => {
    test('returns {ids, count, chunks} with consistent shapes', async () => {
        const res = await api.encode('llama3', 'The quick brown fox');
        assert.ok(Array.isArray(res.ids));
        assert.equal(typeof res.count, 'number');
        assert.ok(Array.isArray(res.chunks));
        assert.equal(res.count, res.ids.length);
        assert.ok(res.ids.every(id => Number.isInteger(id)));
    });

    test('empty text encodes to zero tokens', async () => {
        const res = await api.encode('gpt2', '');
        assert.deepEqual(res.ids, []);
        assert.equal(res.count, 0);
    });

    test('count grows with text length', async () => {
        const short = await api.encode('claude', 'hi');
        const long = await api.encode('claude', 'hi '.repeat(100));
        assert.ok(long.count > short.count);
    });

    test('an unrouted model name 404s (route-level miss)', async () => {
        await assert.rejects(
            () => api.encode('__drvtest_not_a_model__', 'hi'),
            /404/,
        );
    });
});

describe('decode(model, ids)', () => {
    test('returns {text}', async () => {
        const res = await api.decode('llama3', [279, 6518]);
        assert.equal(typeof res.text, 'string');
    });

    test('empty ids decode to an empty-ish string', async () => {
        const res = await api.decode('gpt2', []);
        assert.equal(res.text, '');
    });
});

describe('encode/decode roundtrip per model', () => {
    // Verified live behavior: ST's sentencepiece decode handler decodes each
    // id individually and concatenates, which drops the '▁' whitespace marker
    // for llama and mistral (gemma/yi/jamba/nerdstash* preserve spaces).
    // For those models the roundtrip is asserted on the space-stripped text.
    const SPACE_LOSSY_MODELS = new Set(['llama', 'mistral']);

    for (const model of TOKENIZER_MODELS) {
        test(`roundtrip for ${model}`, async () => {
            const text = 'The quick brown fox jumps over the lazy dog.';
            const enc = await api.encode(model, text);
            assert.ok(enc.count > 0, `${model}: encode must produce tokens`);
            const dec = await api.decode(model, enc.ids);
            const expected = SPACE_LOSSY_MODELS.has(model) ? text.replaceAll(' ', '') : text;
            assert.equal(dec.text, expected, `${model}: decode(encode(x)) must equal x`);
        });
    }

    test('single-word text roundtrips exactly even for space-lossy models', async () => {
        for (const model of ['llama', 'mistral']) {
            const enc = await api.encode(model, 'unbelievable');
            const dec = await api.decode(model, enc.ids);
            assert.equal(dec.text, 'unbelievable');
        }
    });
});

describe('CJK roundtrip', () => {
    test('qwen2 roundtrips Chinese text exactly', async () => {
        const text = '你好，世界！这是一个测试。';
        const enc = await api.encode('qwen2', text);
        assert.ok(enc.count > 0);
        const dec = await api.decode('qwen2', enc.ids);
        assert.equal(dec.text, text);
    });

    test('llama3 roundtrips mixed Chinese/Japanese/English text', async () => {
        const text = 'こんにちは hello 世界';
        const enc = await api.encode('llama3', text);
        const dec = await api.decode('llama3', enc.ids);
        assert.equal(dec.text, text);
    });

    test('gpt2 (byte-level tiktoken) roundtrips Chinese text', async () => {
        const text = '你好世界';
        const enc = await api.encode('gpt2', text);
        assert.ok(enc.count > 0);
        const dec = await api.decode('gpt2', enc.ids);
        assert.equal(dec.text, text);
    });

    test('sentencepiece llama roundtrips Chinese text', async () => {
        const text = '你好世界';
        const enc = await api.encode('llama', text);
        const dec = await api.decode('llama', enc.ids);
        assert.equal(dec.text, text);
    });
});

describe('openaiCount(model, messages)', () => {
    test('returns {token_count} for a gpt model via ?model= query param', async () => {
        const res = await api.openaiCount('gpt-4', [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello there!' },
        ]);
        assert.equal(typeof res.token_count, 'number');
        assert.ok(res.token_count > 0);
    });

    test('token_count grows with message content', async () => {
        const small = await api.openaiCount('gpt-4', [{ role: 'user', content: 'hi' }]);
        const big = await api.openaiCount('gpt-4', [{ role: 'user', content: 'hi '.repeat(200) }]);
        assert.ok(big.token_count > small.token_count);
    });

    test('claude model counts via the web tokenizer path', async () => {
        const res = await api.openaiCount('claude-3-opus', [{ role: 'user', content: 'Count me please' }]);
        assert.equal(typeof res.token_count, 'number');
        assert.ok(res.token_count > 0);
    });

    test('llama3 model counts via the web tokenizer path', async () => {
        const res = await api.openaiCount('llama3-8b', [{ role: 'user', content: 'Count me please' }]);
        assert.equal(typeof res.token_count, 'number');
        assert.ok(res.token_count > 0);
    });

    test('unknown model falls back to gpt-3.5-turbo tokenization', async () => {
        const res = await api.openaiCount('__drvtest_unknown_model__', [{ role: 'user', content: 'hi' }]);
        assert.ok(res.token_count > 0);
    });

    test('omitting the model parameter still counts (default path)', async () => {
        const res = await api.openaiCount(undefined, [{ role: 'user', content: 'hi' }]);
        assert.ok(res.token_count > 0);
    });
});

describe('remote tokenizer endpoints (no backing service running)', () => {
    test('remote/kobold/count with a dead url answers {error:true}', async () => {
        const res = await api.remoteKoboldCount('hello', 'http://127.0.0.1:1');
        assert.deepEqual(res, { error: true });
    });

    test('remote/textgenerationwebui/encode with a dead url answers {error:true}', async () => {
        const res = await api.remoteTextgenEncode('hello', 'http://127.0.0.1:1');
        assert.deepEqual(res, { error: true });
    });

    test('remote/textgenerationwebui/encode accepts api_type and model params', async () => {
        const res = await api.remoteTextgenEncode('hello', 'http://127.0.0.1:1', {
            api_type: 'koboldcpp',
            model: '__drvtest_model',
        });
        assert.deepEqual(res, { error: true });
    });
});
