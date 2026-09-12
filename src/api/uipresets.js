/**
 * UI preset APIs wrapper for the SillyTavern server (ST 1.18.0):
 *
 * - ThemesApi        -> /api/themes        (color/UI theme JSON files)
 * - MovingUiApi      -> /api/moving-ui     (draggable panel layout presets)
 * - QuickRepliesApi  -> /api/quick-replies (quick reply set JSON files)
 *
 * All three endpoints store the ENTIRE request body verbatim as
 * '<sanitize-filename(name)>.json' inside their user directory. There is no
 * schema validation beyond a non-empty `name` — the minimal legal object is
 * simply { name } plus whatever fields the frontend expects when loading it
 * back (documented per class below).
 *
 * Live-verified quirks (1.18.0):
 * - Every /save answers plain text 'OK' (sendStatus(200)), not JSON.
 * - Missing or empty `name` on /save -> 400.
 * - /api/themes/delete of a nonexistent theme -> 404.
 * - /api/quick-replies/delete of a nonexistent set -> 200 'OK' (the handler
 *   only unlinks when the file exists — silent success).
 * - /api/moving-ui has NO delete route at all: POST /api/moving-ui/delete
 *   answers 404 HTML. The frontend manages moving UI presets client-side
 *   only. MovingUiApi.delete() exists for symmetry but always throws.
 * - Saved presets can be listed (parsed) via POST /api/settings/get:
 *   `themes[]`, `movingUIPresets[]`, `quickReplyPresets[]`.
 *
 * Minimal frontend-shaped payloads (verified against public/scripts):
 * - theme: power-user.js getThemeObject() — { name, blur_strength,
 *   main_text_color, italics_text_color, ..., custom_css } (see
 *   data/default-user/themes/*.json for a full example).
 * - moving UI: { name, movingUIState: {} } (power-user.js saveMovingUIState).
 * - quick replies: QuickReplySet.toJSON() — { version: 2, name, disableSend,
 *   placeBeforeInput, injectInput, color, onlyBorderColor, qrList, idIndex }.
 */

const THEMES_BASE = '/api/themes';
const MOVING_UI_BASE = '/api/moving-ui';
const QUICK_REPLIES_BASE = '/api/quick-replies';

/**
 * Require a preset object with a non-empty name.
 * @param {object} preset
 * @param {string} apiName class name for the error message
 * @returns {object}
 */
function requirePresetName(preset, apiName) {
    if (!preset || typeof preset !== 'object') {
        throw new TypeError(`${apiName}: a preset object is required (got ${preset})`);
    }
    if (preset.name === undefined || preset.name === null || !String(preset.name).trim().length) {
        throw new TypeError(`${apiName}: preset.name is required (got ${preset.name})`);
    }
    return preset;
}

/**
 * Require a non-empty `name` for delete calls.
 * @param {string} name
 * @param {string} apiName class name for the error message
 * @returns {string}
 */
function requireDeleteName(name, apiName) {
    if (name === undefined || name === null || !String(name).trim().length) {
        throw new TypeError(`${apiName}: delete() requires a non-empty name (got ${name})`);
    }
    return String(name);
}

/**
 * Wrapper around /api/themes/* — saved color/UI themes.
 */
export class ThemesApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Save (create or overwrite) a theme. The whole object is stored
     * verbatim as '<name>.json'.
     * Endpoint: POST /api/themes/save.
     *
     * @param {object} theme theme object; `name` is the only required field.
     * Frontend-shaped payload: { name, blur_strength, main_text_color,
     * italics_text_color, underline_text_color, quote_text_color,
     * blur_tint_color, chat_tint_color, user_mes_blur_tint_color,
     * bot_mes_blur_tint_color, shadow_color, shadow_width, border_color,
     * font_scale, fast_ui_mode, waifuMode, avatar_style, chat_display,
     * noShadows, chat_width, timer_enabled, timestamps_enabled,
     * timestamp_model_icon, mesIDDisplay_enabled, hideChatAvatars_enabled,
     * message_token_count_enabled, expand_message_actions, enableZenSliders,
     * enableLabMode, hotswap_enabled, custom_css, bogus_folders,
     * reduced_motion, compact_input_area }
     * @returns {Promise<string>} plain text 'OK'
     * @throws {TypeError} client-side when theme or theme.name is missing
     * @throws {import('../core/client.js').StApiError} 400 when the name is
     * missing or empty server-side
     */
    async save(theme) {
        requirePresetName(theme, 'ThemesApi');
        return await this.client.postRaw(`${THEMES_BASE}/save`, theme);
    }

    /**
     * Delete a saved theme.
     * Endpoint: POST /api/themes/delete { name }.
     *
     * @param {object} params
     * @param {string} params.name theme name (without .json)
     * @returns {Promise<string>} plain text 'OK'
     * @throws {TypeError} client-side when name is missing or empty
     * @throws {import('../core/client.js').StApiError} 400 when name is
     * missing server-side; 404 when the theme file does not exist
     */
    async delete({ name }) {
        return await this.client.postRaw(`${THEMES_BASE}/delete`, { name: requireDeleteName(name, 'ThemesApi') });
    }
}

/**
 * Wrapper around /api/moving-ui/* — saved draggable panel layouts.
 * NOTE: ST 1.18.0 only provides /save; there is no delete endpoint.
 */
export class MovingUiApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Save (create or overwrite) a moving UI preset.
     * Endpoint: POST /api/moving-ui/save.
     *
     * @param {object} preset { name, movingUIState } — movingUIState maps
     * element ids to position/size objects; {} is the reset state
     * @returns {Promise<string>} plain text 'OK'
     * @throws {TypeError} client-side when preset or preset.name is missing
     * @throws {import('../core/client.js').StApiError} 400 when the name is
     * missing or empty server-side
     */
    async save(preset) {
        requirePresetName(preset, 'MovingUiApi');
        return await this.client.postRaw(`${MOVING_UI_BASE}/save`, preset);
    }

    /**
     * Delete a moving UI preset — NOT SUPPORTED by ST 1.18.0.
     * Endpoint: POST /api/moving-ui/delete { name } (route does not exist).
     *
     * @param {object} params
     * @param {string} params.name preset name
     * @returns {Promise<string>} never resolves successfully
     * @throws {TypeError} client-side when name is missing or empty
     * @throws {import('../core/client.js').StApiError} always 404 — the
     * server has no moving-ui delete route; the frontend only manages these
     * presets client-side, and removal requires deleting the JSON file from
     * the movingUI user directory directly
     */
    async delete({ name }) {
        return await this.client.postRaw(`${MOVING_UI_BASE}/delete`, { name: requireDeleteName(name, 'MovingUiApi') });
    }
}

/**
 * Wrapper around /api/quick-replies/* — saved quick reply sets.
 */
export class QuickRepliesApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Save (create or overwrite) a quick reply set.
     * Endpoint: POST /api/quick-replies/save.
     *
     * @param {object} set QuickReplySet.toJSON()-shaped object; `name` is the
     * only field the server enforces. Frontend shape: { version: 2, name,
     * disableSend, placeBeforeInput, injectInput, color, onlyBorderColor,
     * qrList: [{ id, showLabel, label, title, message, contextList,
     * preventAutoExecute, isHidden, executeOnStartup, executeOnUser,
     * executeOnAi, executeOnChatChange, executeOnGroupMemberDraft,
     * executeOnNewChat, executeBeforeGeneration, automationId }], idIndex }
     * @returns {Promise<string>} plain text 'OK'
     * @throws {TypeError} client-side when set or set.name is missing
     * @throws {import('../core/client.js').StApiError} 400 when the name is
     * missing or empty server-side
     */
    async save(set) {
        requirePresetName(set, 'QuickRepliesApi');
        return await this.client.postRaw(`${QUICK_REPLIES_BASE}/save`, set);
    }

    /**
     * Delete a saved quick reply set.
     * Endpoint: POST /api/quick-replies/delete { name }.
     *
     * @param {object} params
     * @param {string} params.name set name (without .json)
     * @returns {Promise<string>} plain text 'OK'. QUIRK: deleting a set that
     * does not exist ALSO answers 'OK' (silent success, HTTP 200).
     * @throws {TypeError} client-side when name is missing or empty
     * @throws {import('../core/client.js').StApiError} 400 when name is
     * missing server-side
     */
    async delete({ name }) {
        return await this.client.postRaw(`${QUICK_REPLIES_BASE}/delete`, { name: requireDeleteName(name, 'QuickRepliesApi') });
    }
}
