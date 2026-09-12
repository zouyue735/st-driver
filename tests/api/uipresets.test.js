/**
 * LIVE integration tests for the UI preset APIs (src/api/uipresets.js):
 * ThemesApi, MovingUiApi, QuickRepliesApi.
 *
 * All fixtures use the __drvtest_ prefix. Themes and Quick Replies are
 * removed through their /delete endpoints; MovingUI presets are removed
 * through the filesystem in after() because ST 1.18.0 has NO moving-ui
 * delete endpoint (verified live: POST /api/moving-ui/delete -> 404).
 *
 * Preset listing is verified through POST /api/settings/get, which returns
 * the parsed themes[], movingUIPresets[] and quickReplyPresets[] arrays
 * (readAndParseFromDirectory over the user's preset folders).
 *
 * Verified quirks (ST 1.18.0):
 * - All /save endpoints answer plain text 'OK' (sendStatus(200)), NOT JSON.
 * - Missing `name` on any /save -> 400 (empty body -> 400 too).
 * - /api/themes/delete of a nonexistent theme -> 404.
 * - /api/quick-replies/delete of a nonexistent set -> 200 'OK' (silent
 *   success; the handler only unlinks when the file exists).
 * - /api/moving-ui/delete does not exist at all -> 404 HTML 'Not Found'.
 * - The whole request body is stored verbatim as <name>.json (the name is
 *   sanitized with sanitize-filename first).
 *
 * Minimal legal payload shapes (from the frontend):
 * - theme: power-user.js getThemeObject() — full object with blur_strength,
 *   colors, font_scale, chat_display, custom_css, ... (only `name` is
 *   enforced server-side; the frontend always saves the complete object).
 * - moving UI: { name, movingUIState: {} } (power-user.js saveMovingUIState).
 * - quick replies: QuickReplySet.toJSON() -> { version: 2, name, disableSend,
 *   placeBeforeInput, injectInput, color, onlyBorderColor, qrList, idIndex }.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ThemesApi, MovingUiApi, QuickRepliesApi } from '../../src/api/uipresets.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, dataRoot } from '../helpers.js';

let client;
let themes;
let movingUi;
let quickReplies;

/** ST user data root — movingUI fixtures must be removed via fs (no endpoint). */
const DATA_ROOT = dataRoot();

/** MovingUI preset names created by these tests (fs cleanup in after()). */
const movingUiFixtures = [];

before(async () => {
    client = await newClient();
    themes = new ThemesApi(client);
    movingUi = new MovingUiApi(client);
    quickReplies = new QuickRepliesApi(client);
});

after(async () => {
    // movingUI presets have no HTTP delete; sweep them from disk when possible.
    if (DATA_ROOT) {
        for (const name of movingUiFixtures) {
            fs.rmSync(path.join(DATA_ROOT, 'movingUI', `${name}.json`), { force: true });
        }
    }
    await client?.close();
});

/**
 * Fetch the parsed preset lists from /api/settings/get.
 * @returns {Promise<{themes: object[], movingUIPresets: object[], quickReplyPresets: object[]}>}
 */
async function settingsPresets() {
    const res = await client.post('/api/settings/get', {});
    return {
        themes: res.themes ?? [],
        movingUIPresets: res.movingUIPresets ?? [],
        quickReplyPresets: res.quickReplyPresets ?? [],
    };
}

/**
 * A minimal but frontend-shaped theme object (fields from
 * public/scripts/power-user.js getThemeObject / data themes/*.json).
 * @param {string} name
 * @returns {object}
 */
function themeObject(name) {
    return {
        name,
        blur_strength: 5,
        main_text_color: 'rgba(220, 220, 210, 1)',
        italics_text_color: 'rgba(145, 190, 185, 1)',
        underline_text_color: 'rgba(188, 231, 207, 1)',
        quote_text_color: 'rgba(225, 138, 131, 1)',
        blur_tint_color: 'rgba(23, 23, 23, 0.61)',
        chat_tint_color: 'rgba(23, 23, 23, 0)',
        user_mes_blur_tint_color: 'rgba(0, 28, 174, 0.2)',
        bot_mes_blur_tint_color: 'rgba(0, 13, 57, 0.22)',
        shadow_color: 'rgba(0, 0, 0, 1)',
        shadow_width: 2,
        border_color: 'rgba(0, 0, 0, 0.5)',
        font_scale: 1,
        fast_ui_mode: true,
        waifuMode: false,
        avatar_style: 0,
        chat_display: 1,
        noShadows: false,
        chat_width: 50,
        timer_enabled: false,
        timestamps_enabled: true,
        timestamp_model_icon: false,
        mesIDDisplay_enabled: false,
        hideChatAvatars_enabled: false,
        message_token_count_enabled: false,
        expand_message_actions: false,
        enableZenSliders: false,
        enableLabMode: false,
        hotswap_enabled: true,
        custom_css: '',
        bogus_folders: false,
        reduced_motion: false,
        compact_input_area: false,
        show_tooltips: true,
        enableToolTips: true,
        enableZenMode: false,
    };
}

/**
 * A minimal but frontend-shaped quick reply set (QuickReplySet.toJSON()).
 * @param {string} name
 * @returns {object}
 */
function quickReplySet(name) {
    return {
        version: 2,
        name,
        disableSend: false,
        placeBeforeInput: false,
        injectInput: false,
        color: 'rgba(0, 0, 0, 0)',
        onlyBorderColor: false,
        qrList: [],
        idIndex: 1,
    };
}

describe('ThemesApi.save (POST /api/themes/save)', () => {
    test('saves a theme and answers plain text OK; settings/get lists it', async () => {
        const name = fixtureName('theme');
        const res = await themes.save(themeObject(name));
        assert.equal(res, 'OK');
        try {
            const { themes: list } = await settingsPresets();
            const found = list.find(t => t.name === name);
            assert.ok(found, 'the saved theme must appear in settings/get themes');
            assert.equal(found.blur_strength, 5);
            assert.equal(found.custom_css, '');
        } finally {
            await themes.delete({ name }).catch(() => {});
        }
    });

    test('save stores the whole body verbatim (extra fields survive)', async () => {
        const name = fixtureName('theme_x');
        await themes.save({ ...themeObject(name), __drvtest_marker: 'marker-value' });
        try {
            const { themes: list } = await settingsPresets();
            const found = list.find(t => t.name === name);
            assert.equal(found.__drvtest_marker, 'marker-value');
        } finally {
            await themes.delete({ name }).catch(() => {});
        }
    });

    test('save without name rejects client-side (TypeError); raw server answers 400', async () => {
        const nameless = themeObject('placeholder');
        delete nameless.name;
        await assert.rejects(
            () => themes.save(nameless),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        // the server itself answers 400 when the name field is truly absent
        await assert.rejects(
            () => client.postRaw('/api/themes/save', { blur_strength: 5 }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save with an empty name rejects client-side; raw server answers 400', async () => {
        await assert.rejects(
            () => themes.save({ name: '', blur_strength: 5 }),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/themes/save', { name: '', blur_strength: 5 }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save overwrites an existing theme of the same name', async () => {
        const name = fixtureName('theme_ow');
        await themes.save({ ...themeObject(name), blur_strength: 1 });
        try {
            await themes.save({ ...themeObject(name), blur_strength: 99 });
            const { themes: list } = await settingsPresets();
            const found = list.filter(t => t.name === name);
            assert.equal(found.length, 1, 'exactly one theme with that name');
            assert.equal(found[0].blur_strength, 99);
        } finally {
            await themes.delete({ name }).catch(() => {});
        }
    });
});

describe('ThemesApi.delete (POST /api/themes/delete)', () => {
    test('deletes an existing theme and answers plain text OK', async () => {
        const name = fixtureName('theme_del');
        await themes.save(themeObject(name));
        const res = await themes.delete({ name });
        assert.equal(res, 'OK');
        const { themes: list } = await settingsPresets();
        assert.ok(!list.some(t => t.name === name), 'the theme must be gone');
    });

    test('delete of a nonexistent theme throws StApiError 404', async () => {
        await assert.rejects(
            () => themes.delete({ name: `__drvtest_no_such_theme_${Date.now()}` }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('delete without name rejects client-side (TypeError); raw server answers 400', async () => {
        await assert.rejects(
            () => themes.delete({}),
            err => err instanceof TypeError && /non-empty name/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/themes/delete', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('MovingUiApi.save (POST /api/moving-ui/save)', () => {
    test('saves a preset {name, movingUIState} and answers plain text OK; settings/get lists it', async () => {
        const name = fixtureName('mui');
        const res = await movingUi.save({ name, movingUIState: {} });
        assert.equal(res, 'OK');
        movingUiFixtures.push(name);
        const { movingUIPresets: list } = await settingsPresets();
        const found = list.find(p => p.name === name);
        assert.ok(found, 'the saved preset must appear in settings/get movingUIPresets');
        assert.deepEqual(found.movingUIState, {});
    });

    test('save persists movingUIState content verbatim', async () => {
        const name = fixtureName('mui_state');
        const state = { __drvtest_panel: { top: 10, left: 20, width: 300, height: 400 } };
        await movingUi.save({ name, movingUIState: state });
        movingUiFixtures.push(name);
        const { movingUIPresets: list } = await settingsPresets();
        assert.deepEqual(list.find(p => p.name === name).movingUIState, state);
    });

    test('save without name rejects client-side (TypeError); raw server answers 400', async () => {
        await assert.rejects(
            () => movingUi.save({ movingUIState: {} }),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/moving-ui/save', { movingUIState: {} }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save with an empty name rejects client-side; raw server answers 400', async () => {
        await assert.rejects(
            () => movingUi.save({ name: '', movingUIState: {} }),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/moving-ui/save', { name: '', movingUIState: {} }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('MovingUiApi.delete (POST /api/moving-ui/delete — endpoint DOES NOT EXIST)', () => {
    test('delete throws StApiError 404 (ST 1.18.0 has no moving-ui delete endpoint)', async () => {
        // Verified live AND in source: src/endpoints/moving-ui.js only defines
        // /save. The frontend manages presets purely client-side, so this
        // wrapper exposes delete() for API symmetry but it can only ever 404.
        await assert.rejects(
            () => movingUi.delete({ name: '__drvtest_whatever' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('QuickRepliesApi.save (POST /api/quick-replies/save)', () => {
    test('saves a quick reply set and answers plain text OK; settings/get lists it', async () => {
        const name = fixtureName('qr');
        const res = await quickReplies.save(quickReplySet(name));
        assert.equal(res, 'OK');
        try {
            const { quickReplyPresets: list } = await settingsPresets();
            const found = list.find(p => p.name === name);
            assert.ok(found, 'the saved set must appear in settings/get quickReplyPresets');
            assert.equal(found.version, 2);
            assert.deepEqual(found.qrList, []);
        } finally {
            await quickReplies.delete({ name }).catch(() => {});
        }
    });

    test('save persists qrList entries verbatim', async () => {
        const name = fixtureName('qr_list');
        const set = quickReplySet(name);
        set.qrList = [{
            id: 1,
            showLabel: false,
            label: '__drvtest entry',
            title: '',
            message: '/echo drvtest',
            contextList: [],
            preventAutoExecute: true,
            isHidden: false,
            executeOnStartup: false,
            executeOnUser: false,
            executeOnAi: false,
            executeOnChatChange: false,
            executeOnGroupMemberDraft: false,
            executeOnNewChat: false,
            executeBeforeGeneration: false,
            automationId: '',
        }];
        await quickReplies.save(set);
        try {
            const { quickReplyPresets: list } = await settingsPresets();
            const found = list.find(p => p.name === name);
            assert.equal(found.qrList.length, 1);
            assert.equal(found.qrList[0].label, '__drvtest entry');
            assert.equal(found.qrList[0].message, '/echo drvtest');
        } finally {
            await quickReplies.delete({ name }).catch(() => {});
        }
    });

    test('save without name rejects client-side (TypeError); raw server answers 400', async () => {
        await assert.rejects(
            () => quickReplies.save({ version: 2, qrList: [] }),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/quick-replies/save', { version: 2, qrList: [] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('save with an empty name rejects client-side; raw server answers 400', async () => {
        await assert.rejects(
            () => quickReplies.save({ name: '', version: 2 }),
            err => err instanceof TypeError && /preset\.name is required/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/quick-replies/save', { name: '', version: 2 }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('QuickRepliesApi.delete (POST /api/quick-replies/delete)', () => {
    test('deletes an existing set and answers plain text OK', async () => {
        const name = fixtureName('qr_del');
        await quickReplies.save(quickReplySet(name));
        const res = await quickReplies.delete({ name });
        assert.equal(res, 'OK');
        const { quickReplyPresets: list } = await settingsPresets();
        assert.ok(!list.some(p => p.name === name), 'the set must be gone');
    });

    test('delete of a nonexistent set STILL answers 200 OK (silent success — quirk)', async () => {
        const res = await quickReplies.delete({ name: `__drvtest_no_such_qr_${Date.now()}` });
        assert.equal(res, 'OK');
    });

    test('delete without name rejects client-side (TypeError); raw server answers 400', async () => {
        await assert.rejects(
            () => quickReplies.delete({}),
            err => err instanceof TypeError && /non-empty name/.test(err.message),
        );
        await assert.rejects(
            () => client.postRaw('/api/quick-replies/delete', {}),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('UI presets end-to-end lifecycle', () => {
    test('theme: save → listed → delete → not listed', async () => {
        const name = fixtureName('theme_life');
        assert.equal(await themes.save(themeObject(name)), 'OK');
        assert.ok((await settingsPresets()).themes.some(t => t.name === name));
        assert.equal(await themes.delete({ name }), 'OK');
        assert.ok(!(await settingsPresets()).themes.some(t => t.name === name));
    });

    test('movingUI: save → listed (delete has no endpoint; fs cleanup)', async (t) => {
        // MovingUI has NO server delete endpoint (verified: 404), so removing the
        // fixture requires filesystem access to the server's data dir.
        if (!DATA_ROOT) return t.skip('set ST_DATA_ROOT to exercise movingUI fs cleanup');
        const name = fixtureName('mui_life');
        assert.equal(await movingUi.save({ name, movingUIState: {} }), 'OK');
        assert.ok((await settingsPresets()).movingUIPresets.some(p => p.name === name));
        // cleanup via fs (there is no HTTP delete)
        fs.rmSync(path.join(DATA_ROOT, 'movingUI', `${name}.json`), { force: true });
        assert.ok(!(await settingsPresets()).movingUIPresets.some(p => p.name === name));
    });

    test('quickReplies: save → listed → delete → not listed', async () => {
        const name = fixtureName('qr_life');
        assert.equal(await quickReplies.save(quickReplySet(name)), 'OK');
        assert.ok((await settingsPresets()).quickReplyPresets.some(p => p.name === name));
        assert.equal(await quickReplies.delete({ name }), 'OK');
        assert.ok(!(await settingsPresets()).quickReplyPresets.some(p => p.name === name));
    });
});
