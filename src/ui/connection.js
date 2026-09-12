/**
 * API connection control for the live frontend.
 *
 * WHY THIS EXISTS (verified live on ST 1.18.0):
 * A freshly launched headless page reports `online_status === 'no_connection'`.
 * In that state `Generate()` assembles the prompt, emits
 * GENERATION_AFTER_COMMANDS / generate_after_data and then RETURNS WITHOUT
 * CALLING THE LLM - no error, no reply. Generation silently produces nothing.
 *
 * The fix is the same one the UI's Connect button performs: run the backend
 * status check and set the online status from its result. Afterwards a real
 * POST /api/backends/chat-completions/generate is issued and the character
 * replies.
 */
export class ConnectionControl {
    /** @param {import('../core/browser.js').StBrowser} browser */
    constructor(browser) {
        this.browser = browser;
    }

    /**
     * Current connection state as the frontend sees it.
     * @returns {Promise<{onlineStatus:string, mainApi:string, source:string|null, model:string|null}>}
     */
    async status() {
        return await this.browser.evaluate(async () => {
            const script = await import('/script.js');
            const oai = await import('/scripts/openai.js');
            const source = oai.oai_settings?.chat_completion_source ?? null;
            return {
                onlineStatus: String(script.online_status ?? ''),
                mainApi: String(script.main_api ?? ''),
                source,
                model: source ? (oai.oai_settings?.[`${source}_model`] ?? null) : null,
            };
        });
    }

    /** @returns {Promise<boolean>} whether the frontend considers itself connected */
    async isConnected() {
        const { onlineStatus } = await this.status();
        return onlineStatus === 'Valid';
    }

    /**
     * Establish (or re-verify) the API connection so generation actually runs.
     *
     * Runs the backend status check, then sets the online status from the
     * result. When `force` is true (default) the status is set to 'Valid' even
     * if the check could not be completed, matching what an already-configured
     * installation needs; pass `force:false` to only accept a real successful
     * check.
     *
     * @param {object} [options]
     * @param {boolean} [options.force=true] set 'Valid' even when the status
     *   endpoint does not return a usable model list
     * @returns {Promise<{onlineStatus:string, checked:boolean, models?:string[], detail?:string}>}
     */
    async connect(options = {}) {
        const force = options.force !== false;
        return await this.browser.evaluate(async ({ force }) => {
            const script = await import('/script.js');
            const oai = await import('/scripts/openai.js');
            const out = { onlineStatus: String(script.online_status ?? ''), checked: false };

            // The chat-completions API is selected via main_api = 'openai'
            // (ST's label for the whole Chat Completion family).
            if (script.main_api !== 'openai') {
                out.mainApiBefore = String(script.main_api ?? '');
                script.main_api = 'openai';
            }

            const source = oai.oai_settings?.chat_completion_source;
            if (!source) {
                out.detail = 'no chat_completion_source configured';
                if (force) {
                    script.setOnlineStatus('Valid');
                    out.onlineStatus = String(script.online_status);
                }
                return out;
            }

            try {
                const res = await fetch('/api/backends/chat-completions/status', {
                    method: 'POST',
                    headers: script.getRequestHeaders(),
                    body: JSON.stringify({
                        chat_completion_source: source,
                        reverse_proxy: oai.oai_settings.reverse_proxy ?? '',
                        proxy_password: oai.oai_settings.proxy_password ?? '',
                        custom_url: oai.oai_settings.custom_url ?? '',
                        secret_id: oai.oai_settings.secret_id ?? '',
                    }),
                });
                out.checked = true;
                out.status = res.status;
                if (res.ok) {
                    const payload = await res.json().catch(() => null);
                    const list = payload?.data ?? [];
                    if (Array.isArray(list) && list.length) {
                        out.models = list.map(m => m.id).slice(0, 50);
                    }
                    script.setOnlineStatus('Valid');
                } else if (force) {
                    script.setOnlineStatus('Status check bypassed');
                    script.setOnlineStatus('Valid');
                    out.detail = `status check returned HTTP ${res.status}; forced Valid`;
                }
            } catch (e) {
                out.detail = `status check failed: ${String(e?.message ?? e)}`;
                if (force) script.setOnlineStatus('Valid');
            }

            out.onlineStatus = String(script.online_status ?? '');
            return out;
        }, { force });
    }

    /**
     * Disconnect: mark the frontend offline (UI "Disconnect" equivalent).
     * @returns {Promise<string>} the resulting online status
     */
    async disconnect() {
        return await this.browser.evaluate(async () => {
            const script = await import('/script.js');
            script.setOnlineStatus('no_connection');
            return String(script.online_status);
        });
    }

    /**
     * Select a chat-completions source and optionally a model, then reconnect.
     * @param {object} options
     * @param {string} [options.source] e.g. 'deepseek', 'openai', 'claude', 'custom'
     * @param {string} [options.model]
     * @param {boolean} [options.force=true]
     * @returns {Promise<{onlineStatus:string, source:string|null, model:string|null}>}
     */
    async select(options = {}) {
        await this.browser.evaluate(async ({ source, model }) => {
            const oai = await import('/scripts/openai.js');
            if (source !== undefined) oai.oai_settings.chat_completion_source = source;
            if (model !== undefined) {
                const s = source ?? oai.oai_settings.chat_completion_source;
                if (s === 'custom') oai.oai_settings.custom_model = model;
                else oai.oai_settings[`${s}_model`] = model;
            }
        }, { source: options.source, model: options.model });
        const result = await this.connect({ force: options.force });
        const status = await this.status();
        return { onlineStatus: result.onlineStatus, source: status.source, model: status.model };
    }
}
