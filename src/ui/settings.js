/**
 * Live UI settings control: sampling parameters, connection profile fields,
 * power-user options - everything the settings panels expose. Changes apply
 * immediately to the running frontend (and optionally persist via save).
 *
 * Storage note: `ctx.chatCompletionSettings` IS the live `oai_settings` object
 * from openai.js; `ctx.powerUserSettings` IS `power_user`. Mutating them and
 * calling ctx.saveSettingsDebounced() persists to settings.json.
 */

/**
 * Map of friendly sampling names -> oai_settings keys (chat completions).
 * Every field the Sampling panel exposes for the Chat Completions API.
 */
export const SAMPLING_FIELDS = {
    temperature: 'temp_openai',
    frequencyPenalty: 'freq_pen_openai',
    presencePenalty: 'pres_pen_openai',
    topP: 'top_p_openai',
    topK: 'top_k_openai',
    minP: 'min_p_openai',
    topA: 'top_a_openai',
    repetitionPenalty: 'repetition_penalty_openai',
    stream: 'stream_openai',
    maxContext: 'openai_max_context',
    maxTokens: 'openai_max_tokens', // "Response length" slider
};

/**
 * Friendly names for connection fields (the API Connection panel).
 */
export const CONNECTION_FIELDS = {
    source: 'chat_completion_source',
    model: null, // resolved per-source: <source>_model
    reverseProxy: 'reverse_proxy',
    customUrl: 'custom_url',
    customIncludeBody: 'custom_include_body',
    customExcludeBody: 'custom_exclude_body',
    customIncludeHeaders: 'custom_include_headers',
};

export class UiSettingsControl {
    /**
     * @param {import('../core/browser.js').StBrowser} browser
     * @param {import('../core/stscript.js').StscriptBridge} [stscript] bridge for
     *   UI-chrome commands (/bg, /theme, /bubble...); when omitted one is created lazily
     */
    constructor(browser, stscript = null) {
        this.browser = browser;
        this.stscript = stscript;
    }

    /** @returns {Promise<import('../core/stscript.js').StscriptBridge>} */
    async #bridge() {
        if (!this.stscript) {
            const { StscriptBridge } = await import('../core/stscript.js');
            this.stscript = new StscriptBridge(this.browser);
        }
        return this.stscript;
    }

    /**
     * Read the entire live settings state (chat completions, power user,
     * amount_gen / max_context globals).
     * @returns {Promise<object>}
     */
    async read() {
        return await this.browser.evaluate(() => {
            const ctx = SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings ?? {};
            const pu = ctx.powerUserSettings ?? {};
            return {
                chatCompletions: JSON.parse(JSON.stringify(oai)),
                powerUser: JSON.parse(JSON.stringify(pu)),
            };
        });
    }

    /**
     * Read current sampling parameters (friendly names).
     * @returns {Promise<Record<string, any>>}
     */
    async getSampling() {
        return await this.browser.evaluate(({ fields }) => {
            const oai = SillyTavern.getContext().chatCompletionSettings ?? {};
            const out = {};
            for (const [friendly, key] of Object.entries(fields)) {
                if (key) out[friendly] = oai[key];
            }
            return out;
        }, { fields: SAMPLING_FIELDS });
    }

    /**
     * Set sampling parameters. Unspecified fields are left untouched.
     * Values are NOT persisted unless {save:true} (mirrors memory-state vs
     * permanent changes in the UI).
     * @param {Record<string, any>} values subset of SAMPLING_FIELDS friendly names
     * @param {object} [options]
     * @param {boolean} [options.save=false] persist to settings.json
     * @returns {Promise<Record<string, any>>} the applied values
     */
    async setSampling(values, options = {}) {
        const applied = await this.browser.evaluate(({ values, fields, save }) => {
            const ctx = SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            const out = {};
            for (const [friendly, value] of Object.entries(values)) {
                const key = fields[friendly];
                if (!key) throw new Error(`unknown sampling field: ${friendly}`);
                if (typeof value === 'number' && !Number.isFinite(value)) {
                    throw new Error(`sampling field ${friendly} must be finite, got ${value}`);
                }
                oai[key] = value;
                out[friendly] = oai[key];
            }
            if (save) ctx.saveSettingsDebounced();
            return out;
        }, { values, fields: SAMPLING_FIELDS, save: !!options.save });
        return applied;
    }

    /**
     * Read the active connection profile (source + model + proxy fields).
     * @returns {Promise<{source:string, model:string, reverseProxy:string, customUrl:string}>}
     */
    async getConnection() {
        return await this.browser.evaluate(() => {
            const oai = SillyTavern.getContext().chatCompletionSettings ?? {};
            const source = oai.chat_completion_source;
            return {
                source,
                model: oai[`${source}_model`] ?? oai.custom_model ?? null,
                reverseProxy: oai.reverse_proxy ?? '',
                customUrl: oai.custom_url ?? '',
            };
        });
    }

    /**
     * Switch the chat-completions source and/or model (live).
     * @param {object} options
     * @param {string} [options.source] e.g. 'openai', 'claude', 'deepseek', 'custom'
     * @param {string} [options.model] model id for the source
     * @param {boolean} [options.save=false]
     * @returns {Promise<void>}
     */
    async setConnection(options = {}) {
        await this.browser.evaluate(({ source, model, save }) => {
            const ctx = SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            if (source !== undefined) {
                oai.chat_completion_source = source;
            }
            if (model !== undefined) {
                const s = oai.chat_completion_source;
                if (s === 'custom') oai.custom_model = model;
                else oai[`${s}_model`] = model;
            }
            if (save) ctx.saveSettingsDebounced();
        }, { source: options.source, model: options.model, save: !!options.save });
    }

    /**
     * Read response-length / context-size globals (the top-level sliders that
     * apply to every API).
     * @returns {Promise<{amountGen:number, maxContext:number}>}
     */
    async getGenerationLimits() {
        return await this.browser.evaluate(async () => {
            const script = await import('/script.js');
            return {
                amountGen: Number(script.amount_gen ?? NaN),
                maxContext: Number(script.max_context ?? NaN),
            };
        });
    }

    /**
     * Set response length / context size (live).
     *
     * NOTE (verified): amount_gen / max_context are `export let` bindings in
     * script.js - assigning to them from outside the module silently fails
     * (ESM namespace objects are read-only). The ONLY way to change them from
     * the outside is the same path the UI uses: set the slider element value
     * and dispatch an `input` event, which ST's delegated handler turns into
     * the module-internal assignment (+ debounced save).
     * @param {object} values {amountGen?, maxContext?}
     * @param {object} [options] {save:false} additionally force saveSettings()
     * @returns {Promise<void>}
     */
    async setGenerationLimits(values, options = {}) {
        await this.browser.evaluate(async ({ values, save }) => {
            const script = await import('/script.js');
            const setSlider = (selector, value) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error(`slider ${selector} not found`);
                el.value = String(Number(value));
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            if (values.amountGen !== undefined) setSlider('#amount_gen', values.amountGen);
            if (values.maxContext !== undefined) setSlider('#max_context', values.maxContext);
            // give the input handler a tick to apply the module binding
            await new Promise(r => setTimeout(r, 50));
            if (save) {
                await script.saveSettings();
            }
        }, { values, save: !!options.save });
    }

    /**
     * Read an arbitrary power_user setting.
     * @param {string} key e.g. 'auto_continue', 'swipes', 'chat_truncation'
     * @returns {Promise<any>}
     */
    async getPowerUserSetting(key) {
        return await this.browser.evaluate(({ key }) => {
            const pu = SillyTavern.getContext().powerUserSettings ?? {};
            return JSON.parse(JSON.stringify(pu[key] ?? null));
        }, { key });
    }

    /**
     * Set a power_user setting (live).
     * @param {string} key
     * @param {any} value
     * @param {object} [options] {save:false}
     * @returns {Promise<void>}
     */
    async setPowerUserSetting(key, value, options = {}) {
        await this.browser.evaluate(({ key, value, save }) => {
            const ctx = SillyTavern.getContext();
            ctx.powerUserSettings[key] = value;
            if (save) ctx.saveSettingsDebounced();
        }, { key, value, save: !!options.save });
    }

    /**
     * Persist ALL current live settings to settings.json (the UI's "settings
     * are saved automatically" path, forced).
     * @returns {Promise<void>}
     */
    async save() {
        await this.browser.evaluate(async () => {
            const script = await import('/script.js');
            await script.saveSettings();
        });
    }

    /**
     * Switch the UI background by name (fuzzy, like /bg).
     * @param {string} name
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async setBackground(name) {
        const bridge = await this.#bridge();
        return await bridge.invoke('bg', { text: String(name) });
    }

    /**
     * Switch the UI theme by name.
     * @param {string} name
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async setTheme(name) {
        const bridge = await this.#bridge();
        return await bridge.invoke('theme', { text: String(name) });
    }

    /**
     * Set the message rendering style (bubble / flat / document "single").
     * @param {'bubble'|'flat'|'single'} style
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async setMessageStyle(style) {
        const cmd = { bubble: 'bubble', flat: 'flat', single: 'single' }[style];
        if (!cmd) throw new TypeError(`setMessageStyle: expected bubble|flat|single, got ${style}`);
        const bridge = await this.#bridge();
        return await bridge.invoke(cmd);
    }
}
