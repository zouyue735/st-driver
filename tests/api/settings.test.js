/**
 * LIVE INTEGRATION tests for SettingsApi against a running SillyTavern.
 *
 * LOSSLESS PRINCIPLE: this instance is the user's daily driver. Every write
 * test saves the original value first and restores it in the same test or in
 * `after`. Snapshot files created by makeSnapshot() cannot be deleted via the
 * API (no delete endpoint exists) - they stay in the user's backups dir but
 * are subject to ST's own removeOldBackups rotation.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsApi } from '../../src/api/settings.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, FIXTURE_PREFIX } from '../helpers.js';

let client;
let api;
/** Settings object captured before any test ran; used for final restoration. */
let originalSettings;

before(async () => {
    client = await newClient();
    api = new SettingsApi(client);
    originalSettings = await api.getSettings();
});

after(async () => {
    // Safety net: make sure the marker key never survives and user_avatar is original.
    try {
        const current = await api.getSettings();
        let dirty = false;
        if (Object.hasOwn(current, '__drvtest_marker')) {
            delete current.__drvtest_marker;
            dirty = true;
        }
        if (current.user_avatar !== originalSettings.user_avatar) {
            current.user_avatar = originalSettings.user_avatar;
            dirty = true;
        }
        if (current.power_user && Object.hasOwn(current.power_user, '__drvtest_marker')) {
            delete current.power_user.__drvtest_marker;
            dirty = true;
        }
        if (current.oai_settings && Object.hasOwn(current.oai_settings, '__drvtest_marker')) {
            delete current.oai_settings.__drvtest_marker;
            dirty = true;
        }
        if (dirty) {
            await api.save(current);
        }
    } catch { /* server may be gone; nothing to restore */ }
    await client?.close();
});

describe('SettingsApi.get()', () => {
    test('returns the full settings envelope', async () => {
        const res = await api.get();
        assert.equal(typeof res, 'object');
        assert.ok(res !== null);
    });

    test('settings field is a JSON *string* (needs JSON.parse)', async () => {
        const res = await api.get();
        assert.equal(typeof res.settings, 'string');
        const parsed = JSON.parse(res.settings);
        assert.equal(typeof parsed, 'object');
    });

    test('envelope contains preset/theme collection arrays', async () => {
        const res = await api.get();
        for (const key of [
            'koboldai_settings', 'openai_settings', 'novelai_settings',
            'textgenerationwebui_presets', 'themes', 'movingUIPresets',
            'quickReplyPresets', 'instruct', 'context', 'sysprompt', 'reasoning',
        ]) {
            assert.ok(Array.isArray(res[key]), `${key} must be an array`);
        }
    });

    test('envelope contains world_names array and boolean flags', async () => {
        const res = await api.get();
        assert.ok(Array.isArray(res.world_names));
        assert.equal(typeof res.enable_extensions, 'boolean');
        assert.equal(typeof res.enable_accounts, 'boolean');
    });
});

describe('SettingsApi.getSettings()', () => {
    test('returns the parsed settings object (not a string)', async () => {
        const settings = await api.getSettings();
        assert.equal(typeof settings, 'object');
        assert.ok(settings !== null);
    });

    test('parsed settings exposes power_user and oai_settings objects', async () => {
        const settings = await api.getSettings();
        assert.equal(typeof settings.power_user, 'object');
        assert.equal(typeof settings.oai_settings, 'object');
    });
});

describe('SettingsApi.save() round trip', () => {
    test('add marker key -> save -> get verifies it persisted', async () => {
        const settings = await api.getSettings();
        assert.ok(!Object.hasOwn(settings, '__drvtest_marker'), 'marker must not pre-exist');
        settings.__drvtest_marker = `${FIXTURE_PREFIX}marker`;
        const res = await api.save(settings);
        assert.deepEqual(res, { result: 'ok' });
        const check = await api.getSettings();
        assert.equal(check.__drvtest_marker, `${FIXTURE_PREFIX}marker`);
    });

    test('remove marker key -> save -> get verifies it is gone (restore)', async () => {
        const settings = await api.getSettings();
        delete settings.__drvtest_marker;
        await api.save(settings);
        const check = await api.getSettings();
        assert.ok(!Object.hasOwn(check, '__drvtest_marker'));
    });

    test('power_user sub-object is writable (marker added then removed)', async () => {
        const settings = await api.getSettings();
        settings.power_user.__drvtest_marker = true;
        await api.save(settings);
        let check = await api.getSettings();
        assert.equal(check.power_user.__drvtest_marker, true);
        // restore
        delete check.power_user.__drvtest_marker;
        await api.save(check);
        check = await api.getSettings();
        assert.ok(!Object.hasOwn(check.power_user, '__drvtest_marker'));
    });

    test('oai_settings sub-object is writable (marker added then removed)', async () => {
        const settings = await api.getSettings();
        settings.oai_settings.__drvtest_marker = 'x';
        await api.save(settings);
        let check = await api.getSettings();
        assert.equal(check.oai_settings.__drvtest_marker, 'x');
        // restore
        delete check.oai_settings.__drvtest_marker;
        await api.save(check);
        check = await api.getSettings();
        assert.ok(!Object.hasOwn(check.oai_settings, '__drvtest_marker'));
    });

    test('user_avatar field is writable and restored to the original value', async () => {
        const settings = await api.getSettings();
        const original = settings.user_avatar;
        settings.user_avatar = '__drvtest_avatar_placeholder.png';
        await api.save(settings);
        let check = await api.getSettings();
        assert.equal(check.user_avatar, '__drvtest_avatar_placeholder.png');
        // restore original value
        check.user_avatar = original;
        await api.save(check);
        check = await api.getSettings();
        assert.equal(check.user_avatar, original);
        assert.equal(check.user_avatar, originalSettings.user_avatar);
    });
});

describe('SettingsApi snapshots', () => {
    let madeSnapshotName;

    test('getSnapshots() returns an array of {date,name,size}', async () => {
        const snapshots = await api.getSnapshots();
        assert.ok(Array.isArray(snapshots));
        for (const snap of snapshots) {
            assert.equal(typeof snap.date, 'number');
            assert.equal(typeof snap.name, 'string');
            assert.equal(typeof snap.size, 'number');
        }
    });

    test('makeSnapshot() creates a snapshot that appears in getSnapshots()', async () => {
        const before = await api.getSnapshots();
        const res = await api.makeSnapshot();
        assert.equal(res, null, 'endpoint answers 204 (null)');
        const afterSnapshots = await api.getSnapshots();
        assert.ok(afterSnapshots.length >= before.length);
        const beforeNames = new Set(before.map(s => s.name));
        const fresh = afterSnapshots.find(s => !beforeNames.has(s.name));
        // If a snapshot with the same second-granularity timestamp existed, fresh may be undefined;
        // fall back to the newest entry.
        madeSnapshotName = fresh?.name ?? afterSnapshots
            .slice()
            .sort((a, b) => b.date - a.date)[0].name;
        assert.match(madeSnapshotName, /^settings_.+_\d{8}-\d{6}\.json$/);
    });

    test('loadSnapshot({name}) returns the settings JSON content as a string', async () => {
        assert.ok(madeSnapshotName, 'previous test must have produced a snapshot name');
        const content = await api.loadSnapshot({ name: madeSnapshotName });
        assert.equal(typeof content, 'string');
        const parsed = JSON.parse(content);
        assert.equal(typeof parsed, 'object');
        assert.ok(Object.hasOwn(parsed, 'power_user'), 'snapshot contains real settings');
    });

    test('restoreSnapshot({name}) of the just-made snapshot is lossless', async () => {
        const expected = JSON.parse(await api.loadSnapshot({ name: madeSnapshotName }));
        const res = await api.restoreSnapshot({ name: madeSnapshotName });
        assert.equal(res, null, 'endpoint answers 204 (null)');
        const current = await api.getSettings();
        assert.deepEqual(current, expected);
    });

    test('loadSnapshot rejects a name without the user prefix with 400', async () => {
        await assert.rejects(
            () => api.loadSnapshot({ name: '__drvtest_bogus.json' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('restoreSnapshot rejects a name without the user prefix with 400', async () => {
        await assert.rejects(
            () => api.restoreSnapshot({ name: '__drvtest_bogus.json' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('loadSnapshot of a missing (but well-prefixed) snapshot 404s', async () => {
        await assert.rejects(
            () => api.loadSnapshot({ name: 'settings_default-user_19700101-000000.json' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});
