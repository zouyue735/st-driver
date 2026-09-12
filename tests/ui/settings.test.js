import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';
import { SAMPLING_FIELDS } from '../../src/ui/settings.js';

// Live integration tests for UiSettingsControl.
// NON-DESTRUCTIVE: every mutation test captures the original live value and
// restores it in a finally block; nothing is persisted (save defaults false).
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 240_000;

let session;

before(async () => {
    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
});

after(async () => {
    await session?.close();
});

/** Run fn, then restore `field` of the live oai_settings to its original value. */
async function withRestoredSampling(field, fn) {
    const original = await session.evaluate(({ key }) => {
        return SillyTavern.getContext().chatCompletionSettings[key];
    }, { key: SAMPLING_FIELDS[field] });
    try {
        return await fn(original);
    } finally {
        await session.evaluate(({ key, value }) => {
            SillyTavern.getContext().chatCompletionSettings[key] = value;
        }, { key: SAMPLING_FIELDS[field], value: original });
    }
}

describe('UiSettingsControl: reads', { timeout: TEST_TIMEOUT }, () => {
    test('read returns chatCompletions and powerUser objects', async () => {
        const all = await session.settings.read();
        assert.equal(typeof all.chatCompletions, 'object');
        assert.equal(typeof all.powerUser, 'object');
        assert.ok('temp_openai' in all.chatCompletions);
    });

    test('getSampling returns every friendly sampling field', async () => {
        const sampling = await session.settings.getSampling();
        for (const friendly of Object.keys(SAMPLING_FIELDS)) {
            assert.ok(friendly in sampling, `missing ${friendly}`);
        }
        assert.equal(typeof sampling.temperature, 'number');
        assert.equal(typeof sampling.maxTokens, 'number');
    });

    test('getConnection reports the active source', async () => {
        const conn = await session.settings.getConnection();
        assert.equal(typeof conn.source, 'string');
        assert.ok(conn.source.length > 0);
        assert.ok('model' in conn);
    });

    test('getGenerationLimits returns numeric amountGen/maxContext', async () => {
        const limits = await session.settings.getGenerationLimits();
        assert.ok(Number.isFinite(limits.amountGen) || limits.amountGen === null);
        assert.ok(Number.isFinite(limits.maxContext) || limits.maxContext === null);
    });
});

describe('UiSettingsControl: sampling mutations (restored)', { timeout: TEST_TIMEOUT }, () => {
    test('setSampling temperature applies to the live oai_settings', async () => {
        await withRestoredSampling('temperature', async () => {
            const applied = await session.settings.setSampling({ temperature: 1.77 });
            assert.equal(applied.temperature, 1.77);
            const check = await session.settings.getSampling();
            assert.equal(check.temperature, 1.77);
        });
    });

    test('setSampling topP applies', async () => {
        await withRestoredSampling('topP', async () => {
            await session.settings.setSampling({ topP: 0.83 });
            const check = await session.settings.getSampling();
            assert.equal(check.topP, 0.83);
        });
    });

    test('setSampling maxTokens applies', async () => {
        await withRestoredSampling('maxTokens', async () => {
            await session.settings.setSampling({ maxTokens: 999 });
            const check = await session.settings.getSampling();
            assert.equal(check.maxTokens, 999);
        });
    });

    test('setSampling applies multiple fields at once', async () => {
        const originals = await session.settings.getSampling();
        try {
            await session.settings.setSampling({ temperature: 0.42, frequencyPenalty: 0.24, presencePenalty: 0.11 });
            const check = await session.settings.getSampling();
            assert.equal(check.temperature, 0.42);
            assert.equal(check.frequencyPenalty, 0.24);
            assert.equal(check.presencePenalty, 0.11);
        } finally {
            await session.settings.setSampling({
                temperature: originals.temperature,
                frequencyPenalty: originals.frequencyPenalty,
                presencePenalty: originals.presencePenalty,
            });
        }
    });

    test('setSampling leaves untouched fields alone', async () => {
        const before = await session.settings.getSampling();
        await withRestoredSampling('temperature', async () => {
            await session.settings.setSampling({ temperature: 1.234 });
            const after = await session.settings.getSampling();
            assert.equal(after.topP, before.topP, 'topP must be unchanged');
            assert.equal(after.maxTokens, before.maxTokens, 'maxTokens must be unchanged');
        });
    });

    test('setSampling rejects an unknown field name', async () => {
        await assert.rejects(
            () => session.settings.setSampling({ notARealField: 1 }),
            /unknown sampling field/,
        );
    });

    test('setSampling rejects a non-finite number', async () => {
        await assert.rejects(
            () => session.settings.setSampling({ temperature: Number.NaN }),
            /must be finite/,
        );
    });
});

describe('UiSettingsControl: connection & power-user (restored)', { timeout: TEST_TIMEOUT }, () => {
    test('setConnection changes the live source (then restores)', async () => {
        const original = await session.settings.getConnection();
        try {
            await session.settings.setConnection({ source: 'openai' });
            const now = await session.settings.getConnection();
            assert.equal(now.source, 'openai');
        } finally {
            await session.settings.setConnection({ source: original.source });
        }
    });

    test('setPowerUserSetting round-trips a value (then restores)', async () => {
        const key = '__drvtest_pu_marker__';
        try {
            await session.settings.setPowerUserSetting(key, 'hello');
            const v = await session.settings.getPowerUserSetting(key);
            assert.equal(v, 'hello');
        } finally {
            await session.evaluate(({ key }) => {
                delete SillyTavern.getContext().powerUserSettings[key];
            }, { key });
        }
        const gone = await session.settings.getPowerUserSetting(key);
        assert.equal(gone, null);
    });

    test('getPowerUserSetting reads a known real setting', async () => {
        // swipes is a long-standing power_user boolean
        const swipes = await session.settings.getPowerUserSetting('swipes');
        assert.ok(swipes === true || swipes === false || swipes === null);
    });

    test('setGenerationLimits applies and restores amountGen', async () => {
        const original = await session.settings.getGenerationLimits();
        try {
            await session.settings.setGenerationLimits({ amountGen: 777 });
            const now = await session.settings.getGenerationLimits();
            assert.equal(now.amountGen, 777);
        } finally {
            if (original.amountGen !== null) {
                await session.settings.setGenerationLimits({ amountGen: original.amountGen });
            }
        }
    });
});

describe('UiSettingsControl: UI chrome via STscript', { timeout: TEST_TIMEOUT }, () => {
    test('setMessageStyle rejects an invalid style', async () => {
        await assert.rejects(() => session.settings.setMessageStyle('sparkly'), /expected bubble\|flat\|single/);
    });

    test('setMessageStyle bubble then flat runs without error', async () => {
        // capture the current chat_display value to restore
        const original = await session.evaluate(() => document.querySelector('#chat_display')?.value ?? null);
        try {
            const r1 = await session.settings.setMessageStyle('bubble');
            assert.equal(r1.isError, false, r1.errorMessage ?? '');
            const r2 = await session.settings.setMessageStyle('flat');
            assert.equal(r2.isError, false, r2.errorMessage ?? '');
        } finally {
            if (original !== null) {
                await session.evaluate(({ original }) => {
                    const el = document.querySelector('#chat_display');
                    if (el) { el.value = original; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, { original });
            }
        }
    });

    test('setBackground with a bogus name does not throw (STscript tolerates)', async () => {
        const r = await session.settings.setBackground(`__drvtest_no_bg_${Date.now()}`);
        assert.equal(typeof r.isError, 'boolean');
    });
});
