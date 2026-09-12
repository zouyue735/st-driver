/**
 * LIVE INTEGRATION tests for PresetsApi against a running SillyTavern.
 *
 * LOSSLESS PRINCIPLE: every fixture preset name is prefixed with
 * __drvtest_ and deleted at the end of its test (and again in `after`
 * as a safety net). User presets are never touched.
 *
 * Valid apiId values (verified against ST src/endpoints/presets.js
 * getPresetSettingsByAPI): kobold, koboldhorde, novel, textgenerationwebui,
 * openai, instruct, context, sysprompt, reasoning.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PresetsApi, PRESET_API_IDS } from '../../src/api/presets.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, FIXTURE_PREFIX } from '../helpers.js';

let client;
let api;
/** All fixture names created during the run, for the cleanup safety net. */
const created = [];

before(async () => {
    client = await newClient();
    api = new PresetsApi(client);
});

after(async () => {
    for (const { name, apiId } of created) {
        await api.delete({ name, apiId }).catch(() => {});
    }
    await client?.close();
});

describe('PresetsApi module constants', () => {
    test('PRESET_API_IDS lists exactly the nine server-supported ids', () => {
        assert.deepEqual([...PRESET_API_IDS].sort(), [
            'context', 'instruct', 'kobold', 'koboldhorde', 'novel',
            'openai', 'reasoning', 'sysprompt', 'textgenerationwebui',
        ]);
    });
});

describe('save/restore/delete cycle for apiId=openai', () => {
    const name = fixtureName('preset_oai');
    const preset = {
        preset_name: name,
        temp_openai: 1.31,
        top_p_openai: 0.92,
        freq_pen_openai: 0.42,
        pres_pen_openai: 0.32,
        openai_max_tokens: 1024,
        openai_max_context: 8192,
        oai_settings: { streaming_openai: true },
    };

    test('save({name, preset, apiId:"openai"}) returns {name}', async () => {
        created.push({ name, apiId: 'openai' });
        const res = await api.save({ name, preset, apiId: 'openai' });
        assert.deepEqual(res, { name });
    });

    test('saved openai preset appears in settings envelope (readback)', async () => {
        const envelope = await client.post('/api/settings/get', {});
        assert.ok(envelope.openai_setting_names.includes(name));
        const idx = envelope.openai_setting_names.indexOf(name);
        const stored = JSON.parse(envelope.openai_settings[idx]);
        for (const [key, value] of Object.entries(preset)) {
            assert.deepEqual(stored[key], value, `field ${key} must round-trip`);
        }
    });

    test('restore({name, apiId:"openai"}) of a non-default preset returns {isDefault:false, preset:{}}', async () => {
        const res = await api.restore({ name, apiId: 'openai' });
        assert.equal(res.isDefault, false);
        assert.deepEqual(res.preset, {});
    });

    test('delete({name, apiId:"openai"}) removes the preset', async () => {
        await api.delete({ name, apiId: 'openai' });
        const envelope = await client.post('/api/settings/get', {});
        assert.ok(!envelope.openai_setting_names.includes(name));
    });

    test('delete of an already-deleted preset 404s', async () => {
        await assert.rejects(
            () => api.delete({ name, apiId: 'openai' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('save/restore/delete cycle for apiId=instruct', () => {
    const name = fixtureName('preset_instruct');
    const preset = {
        name,
        system_prompt: '__drvtest_ instruct prompt',
        input_sequence: '<|USER|>',
        output_sequence: '<|ASSISTANT|>',
        last_output_sequence: '<|ASSISTANT|>',
        stops: '</s>\n',
    };

    test('save({name, preset, apiId:"instruct"}) returns {name}', async () => {
        created.push({ name, apiId: 'instruct' });
        const res = await api.save({ name, preset, apiId: 'instruct' });
        assert.deepEqual(res, { name });
    });

    test('saved instruct preset is listed in the envelope and fields match', async () => {
        const envelope = await client.post('/api/settings/get', {});
        const stored = envelope.instruct.find(p => p.name === name);
        assert.ok(stored, 'instruct preset must appear in envelope.instruct');
        assert.equal(stored.system_prompt, preset.system_prompt);
        assert.equal(stored.input_sequence, preset.input_sequence);
        assert.equal(stored.output_sequence, preset.output_sequence);
    });

    test('restore of the shipped "ChatML" instruct preset returns isDefault:true with content', async () => {
        const res = await api.restore({ name: 'ChatML', apiId: 'instruct' });
        assert.equal(res.isDefault, true);
        assert.equal(typeof res.preset, 'object');
        assert.ok(Object.keys(res.preset).length > 0);
    });

    test('delete({name, apiId:"instruct"}) removes the preset', async () => {
        await api.delete({ name, apiId: 'instruct' });
        const envelope = await client.post('/api/settings/get', {});
        assert.ok(!envelope.instruct.some(p => p.name === name));
    });
});

describe('save/restore/delete cycle for apiId=context', () => {
    const name = fixtureName('preset_context');
    const preset = {
        name,
        story_string: '{{world}} {{description}} __drvtest_',
        example_separator: '<START>',
        chat_start: '<START>',
    };

    test('save({name, preset, apiId:"context"}) returns {name}', async () => {
        created.push({ name, apiId: 'context' });
        const res = await api.save({ name, preset, apiId: 'context' });
        assert.deepEqual(res, { name });
    });

    test('saved context preset is listed in the envelope and fields match', async () => {
        const envelope = await client.post('/api/settings/get', {});
        const stored = envelope.context.find(p => p.name === name);
        assert.ok(stored, 'context preset must appear in envelope.context');
        assert.equal(stored.story_string, preset.story_string);
        assert.equal(stored.example_separator, preset.example_separator);
        assert.equal(stored.chat_start, preset.chat_start);
    });

    test('restore({name, apiId:"context"}) of a non-default preset returns isDefault:false', async () => {
        const res = await api.restore({ name, apiId: 'context' });
        assert.equal(res.isDefault, false);
        assert.deepEqual(res.preset, {});
    });

    test('delete({name, apiId:"context"}) removes the preset', async () => {
        await api.delete({ name, apiId: 'context' });
        const envelope = await client.post('/api/settings/get', {});
        assert.ok(!envelope.context.some(p => p.name === name));
    });
});

describe('save/restore/delete cycle for remaining apiIds', () => {
    for (const apiId of ['kobold', 'koboldhorde', 'novel', 'textgenerationwebui', 'sysprompt', 'reasoning']) {
        test(`save + delete works for apiId=${apiId}`, async () => {
            const name = fixtureName(`preset_${apiId.replace(/[^a-z]/g, '')}`);
            created.push({ name, apiId });
            const res = await api.save({ name, preset: { name, __drvtest: true }, apiId });
            assert.deepEqual(res, { name });
            await api.delete({ name, apiId });
        });
    }
});

describe('error handling', () => {
    test('save with an invalid apiId 400s', async () => {
        const name = fixtureName('preset_bad');
        await assert.rejects(
            () => api.save({ name, preset: { a: 1 }, apiId: '__drvtest_bogus_api__' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save without a preset body 400s', async () => {
        const name = fixtureName('preset_nobody');
        await assert.rejects(
            () => api.save({ name, apiId: 'openai' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save without a name errors (server 500s: sanitize(undefined) throws before validation)', async () => {
        await assert.rejects(
            () => api.save({ preset: { a: 1 }, apiId: 'openai' }),
            err => err instanceof StApiError && err.status >= 400,
        );
    });

    test('delete with an invalid apiId 400s', async () => {
        const name = fixtureName('preset_bad_del');
        await assert.rejects(
            () => api.delete({ name, apiId: 'not-a-real-api' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete without a name errors (server 500s: same sanitize quirk)', async () => {
        await assert.rejects(
            () => api.delete({ apiId: 'openai' }),
            err => err instanceof StApiError && err.status >= 400,
        );
    });

    test('save with a valid apiId but path-traversal chars in name is sanitized server-side', async () => {
        // sanitize-filename strips "../"; the sanitized name is echoed back.
        const res = await api.save({ name: `${FIXTURE_PREFIX}safe../name`, preset: { a: 1 }, apiId: 'openai' });
        assert.equal(typeof res.name, 'string');
        assert.ok(!res.name.includes('/'));
        created.push({ name: res.name, apiId: 'openai' });
        await api.delete({ name: res.name, apiId: 'openai' });
    });
});
