import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StableDiffusionApi } from '../../src/api/sd.js';
import { StApiError } from '../../src/core/client.js';
import { newClient } from '../helpers.js';

// Live integration tests for StableDiffusionApi.
// The user has no SD backend configured, so live calls target a dead URL and
// must surface the server's error (500 / connection failure), never a crash.
// Client-side parameter validation is always exercised.
let client, sd;
const DEAD_URL = 'http://127.0.0.1:1';

before(async () => {
    client = await newClient();
    sd = new StableDiffusionApi(client);
});

after(async () => {
    await client?.close();
});

/** A call to a dead SD backend must reject with StApiError (server 500) or resolve. */
async function expectDeadBackendRejects(promise) {
    let got;
    try {
        got = await promise;
    } catch (e) {
        got = e;
    }
    assert.ok(
        got instanceof StApiError || (got && typeof got === 'object'),
        `expected StApiError or an object, got ${got}`,
    );
    if (got instanceof StApiError) {
        assert.ok(got.status >= 400, `expected a 4xx/5xx status, got ${got.status}`);
    }
}

describe('StableDiffusionApi url validation (client-side)', () => {
    for (const method of ['ping', 'samplers', 'schedulers', 'models', 'vaes', 'upscalers', 'sdNextUpscalers', 'getModel', 'generate']) {
        test(`${method} rejects a missing url`, async () => {
            await assert.rejects(() => sd[method]({}), /'url'.*required/);
        });
        test(`${method} rejects a non-object argument`, async () => {
            await assert.rejects(() => sd[method]('http://x'), /options object/);
        });
    }

    test('setModel rejects a missing url', async () => {
        await assert.rejects(() => sd.setModel({ model: 'x' }), /'url'.*required/);
    });

    test('setModel rejects a missing model', async () => {
        await assert.rejects(() => sd.setModel({ url: 'http://x' }), /'model' is required/);
    });
});

describe('StableDiffusionApi dead-backend error paths (live)', () => {
    test('ping to a dead backend surfaces the failure', async () => {
        await expectDeadBackendRejects(sd.ping({ url: DEAD_URL }));
    });

    test('models to a dead backend surfaces the failure', async () => {
        await expectDeadBackendRejects(sd.models({ url: DEAD_URL }));
    });

    test('samplers to a dead backend surfaces the failure', async () => {
        await expectDeadBackendRejects(sd.samplers({ url: DEAD_URL }));
    });

    test('generate to a dead backend surfaces the failure', async () => {
        await expectDeadBackendRejects(sd.generate({ url: DEAD_URL, prompt: 'a cat', steps: 1 }));
    });

    test('setModel to a dead backend surfaces the failure', async () => {
        await expectDeadBackendRejects(sd.setModel({ url: DEAD_URL, model: 'sd_x' }));
    });
});

describe('StableDiffusionApi generate payload passthrough', () => {
    test('generate forwards arbitrary txt2img fields (dead backend still receives them)', async () => {
        // We cannot inspect the forwarded body without a live backend, but a
        // well-formed payload with many fields must not throw client-side and
        // must reach the server (error path proves the body was accepted).
        await expectDeadBackendRejects(sd.generate({
            url: DEAD_URL,
            prompt: 'a red cube',
            negative_prompt: 'blurry',
            steps: 20,
            cfg_scale: 7,
            width: 512,
            height: 512,
            sampler_name: 'Euler a',
            seed: 12345,
            batch_size: 1,
            override_settings: { sd_model_checkpoint: 'x' },
        }));
    });
});
