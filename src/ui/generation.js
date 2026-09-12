/**
 * Generation control through the frontend pipeline: the full prompt assembly
 * (context template, instruct, world info, author's note, regex, personas)
 * happens in the browser, so generation MUST be driven here rather than via
 * the raw /api/backends endpoints.
 *
 * Under the hood: ctx.generate(type, options) === the UI's Generate().
 * `type` values (from public/script.js Generate): 'normal', 'quiet', 'continue',
 * 'impersonate', 'swipe', 'regenerate', 'auto-continue', ...
 */
export class GenerationControl {
    /**
     * @param {import('../core/browser.js').StBrowser} browser
     * @param {import('../core/stscript.js').StscriptBridge} stscript
     * @param {import('./connection.js').ConnectionControl} [connection]
     */
    constructor(browser, stscript, connection = null) {
        this.browser = browser;
        this.stscript = stscript;
        this.connection = connection;
    }

    /**
     * Ensure the frontend has a live API connection before generating.
     *
     * A headless page starts as 'no_connection', in which state Generate()
     * assembles the prompt and returns WITHOUT calling the LLM (verified).
     * @returns {Promise<void>}
     */
    async #ensureConnected() {
        if (!this.connection) return;
        if (!(await this.connection.isConnected())) {
            await this.connection.connect();
        }
    }

    /**
     * Trigger a generation and wait for it to finish.
     *
     * @param {object} [options]
     * @param {'normal'|'continue'|'regenerate'|'swipe'|'impersonate'|'quiet'|'auto-continue'} [options.type='normal']
     * @param {number|null} [options.forceCharacterId] index into ctx.characters that must reply (group chats)
     * @param {boolean} [options.automaticTrigger]
     * @param {string} [options.quietPrompt] prompt for type='quiet'
     * @param {boolean} [options.quietToLoud] show quiet generation in chat
     * @param {boolean} [options.skipWorldInfo] skip WI scan for this generation
     * @param {object} [options.jsonSchema] structured-output schema
     * @param {number} [options.timeout=600000] ms; on timeout the generation is stopped
     * @returns {Promise<{ok:boolean, outcome:string, timedOut:boolean, settledEmpty:boolean,
     *   chatLength:number, lastMessage:object|null}>} `ok` is false when the call
     *   errored, timed out, or the reply settled empty (see `settledEmpty`)
     */
    async generate(options = {}) {
        const {
            type = 'normal',
            forceCharacterId = null,
            automaticTrigger = false,
            quietPrompt = undefined,
            quietToLoud = undefined,
            skipWorldInfo = false,
            jsonSchema = undefined,
            timeout = 600_000,
        } = options;

        const genOptions = { automatic_trigger: automaticTrigger, skipWIAN: skipWorldInfo };
        if (forceCharacterId !== null && forceCharacterId !== undefined) genOptions.force_chid = forceCharacterId;
        if (quietPrompt !== undefined) genOptions.quiet_prompt = quietPrompt;
        if (quietToLoud !== undefined) genOptions.quietToLoud = quietToLoud;
        if (jsonSchema !== undefined) genOptions.jsonSchema = jsonSchema;

        // A 'no_connection' frontend would assemble the prompt and silently
        // skip the LLM call - establish the connection first.
        await this.#ensureConnected();

        return await this.browser.evaluate(async ({ type, genOptions, timeout }) => {
            const ctx = SillyTavern.getContext();
            const chatLengthBefore = (ctx.chat ?? []).length;
            const lastTextBefore = (() => {
                const c = ctx.chat ?? [];
                return c.length ? String(c[c.length - 1].mes ?? '') : null;
            })();

            let timedOut = false;
            const timer = new Promise((resolve) => setTimeout(() => {
                timedOut = true;
                try { ctx.stopGeneration(); } catch { /* nothing running */ }
                resolve('timeout');
            }, timeout));
            const gen = Promise.resolve(ctx.generate(type, genOptions))
                .then(() => 'done')
                .catch(e => `error: ${e?.message ?? e}`);
            const outcome = await Promise.race([gen, timer]);

            // Settle before reading the result.
            //
            // With streaming on (stream_openai), Generate()'s promise can resolve
            // while the reply text is still being flushed into chat[i].mes, so a
            // caller reading immediately sees an EMPTY reply.
            //
            // A "snapshot stopped changing" test is NOT sufficient: during
            // streaming `mes` can sit at '' for several consecutive ticks, so
            // stability is reached while the text is still empty (this produced
            // an intermittent 'reply must be non-empty' failure). So wait for the
            // INTENT instead: generation flag off AND the final message non-empty
            // AND unchanged across two rounds. If that never happens within the
            // settle budget we report settledEmpty rather than silently handing
            // back an empty message.
            //
            // Quiet generations legitimately write nothing to the chat, so they
            // are excluded - otherwise every one would burn the whole settle
            // budget waiting for a message that is never coming.
            const writesToChat = type !== 'quiet' || genOptions.quietToLoud === true;
            let settledEmpty = false;
            if (outcome === 'done' && writesToChat) {
                const script = await import('/script.js');
                const settleDeadline = Date.now() + Math.min(60_000, Math.max(5_000, timeout / 4));
                let stableRounds = 0;
                let prevText = null;
                let prevLen = -1;
                while (Date.now() < settleDeadline) {
                    await new Promise(r => setTimeout(r, 250));
                    if (script.isGenerating()) {
                        stableRounds = 0; prevText = null; prevLen = -1;
                        continue;
                    }
                    const c = ctx.chat ?? [];
                    const final = c.length ? c[c.length - 1] : null;
                    const text = final ? String(final.mes ?? '') : '';
                    if (text.length > 0) {
                        stableRounds = (text === prevText && c.length === prevLen) ? stableRounds + 1 : 0;
                        prevText = text;
                        prevLen = c.length;
                        if (stableRounds >= 2) break;
                    } else {
                        stableRounds = 0; prevText = null; prevLen = -1;
                    }
                }
                const c = ctx.chat ?? [];
                const final = c.length ? c[c.length - 1] : null;
                const grew = c.length > chatLengthBefore
                    || (final ? String(final.mes ?? '') : '') !== lastTextBefore;
                settledEmpty = !grew || !(final && String(final.mes ?? '').length > 0);
            }

            const chat = ctx.chat ?? [];
            const last = chat.length ? chat[chat.length - 1] : null;
            return {
                // false when the call failed, timed out, or produced an empty
                // reply (settledEmpty) - callers must not treat an empty message
                // as a successful generation
                ok: outcome === 'done' && !timedOut && !settledEmpty,
                outcome,
                timedOut,
                settledEmpty,
                chatLength: chat.length,
                lastMessage: last ? {
                    name: last.name ?? null,
                    is_user: !!last.is_user,
                    is_system: !!last.is_system,
                    mes: last.mes ?? '',
                } : null,
            };
        }, { type, genOptions, timeout });
    }

    /**
     * Send user text and generate a reply in one step (what the Send button does).
     *
     * The user message is added via the frontend's own sendMessageAsUser()
     * (verified: merely filling #send_textarea is NOT picked up by Generate in
     * a headless session), then the normal generation pipeline runs.
     * @param {string} text user message; empty string triggers generation without one
     * @param {object} [options] forwarded to generate() (e.g. forceCharacterId, timeout)
     * @returns {Promise<ReturnType<GenerationControl['generate']>>}
     */
    async sendAndGenerate(text, options = {}) {
        if (text) {
            const sent = await this.stscript.invoke('send', { text: String(text) });
            if (sent.isError) throw new Error(`sending the user message failed: ${sent.errorMessage}`);
        }
        return await this.generate({ type: 'normal', ...options });
    }

    /**
     * Generate text with full character context but WITHOUT writing to chat
     * (/gen). Returns the generated text.
     *
     * The prompt is passed to the command callback directly, so quotes, pipes
     * and backslashes inside it are not re-interpreted by the STscript parser.
     * @param {string} prompt
     * @param {object} [options] {as: 'system'|'char', name, length, lock}
     * @returns {Promise<string>}
     */
    async gen(prompt, options = {}) {
        const namedArgs = {};
        if (options.as) namedArgs.as = options.as;
        if (options.name) namedArgs.name = String(options.name);
        if (options.length !== undefined) namedArgs.length = String(Number(options.length));
        if (options.lock !== undefined) namedArgs.lock = options.lock ? 'on' : 'off';
        const r = await this.stscript.invoke('gen', { namedArgs, text: String(prompt ?? '') });
        if (r.isError) throw new Error(`/gen failed: ${r.errorMessage}`);
        return r.pipe;
    }

    /**
     * Generate from a bare prompt: no chat context, nothing written (/genraw).
     * @param {string} prompt
     * @param {object} [options] {system, prefill, length, instruct=true, stop[]}
     * @returns {Promise<string>}
     */
    async genRaw(prompt, options = {}) {
        const namedArgs = {};
        if (options.instruct !== undefined) namedArgs.instruct = options.instruct ? 'on' : 'off';
        if (options.system) namedArgs.system = String(options.system);
        if (options.prefill) namedArgs.prefill = String(options.prefill);
        if (options.length !== undefined) namedArgs.length = String(Number(options.length));
        if (Array.isArray(options.stop) && options.stop.length) {
            namedArgs.stop = options.stop.map(String);
        }
        const r = await this.stscript.invoke('genraw', { namedArgs, text: String(prompt ?? '') });
        if (r.isError) throw new Error(`/genraw failed: ${r.errorMessage}`);
        return r.pipe;
    }

    /**
     * Ask a specific character something without switching the active card
     * (/ask); returns the reply text.
     * @param {string} name character name
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async ask(name, prompt) {
        const r = await this.stscript.invoke('ask', {
            namedArgs: { name: String(name), return: 'pipe' },
            text: String(prompt ?? ''),
        });
        if (r.isError) throw new Error(`/ask failed: ${r.errorMessage}`);
        return r.pipe;
    }

    /** Let the AI write a message as the user (Impersonate button). */
    async impersonate(options = {}) {
        return await this.generate({ type: 'impersonate', ...options });
    }

    /** Continue the last message. */
    async continueLast(options = {}) {
        return await this.generate({ type: 'continue', ...options });
    }

    /** Regenerate (swipe) the last character message. */
    async regenerate(options = {}) {
        return await this.generate({ type: 'regenerate', ...options });
    }

    /** Stop an in-flight generation. */
    async stop() {
        await this.browser.evaluate(() => {
            try { SillyTavern.getContext().stopGeneration(); } catch { /* idle */ }
        });
    }

    /** @returns {Promise<boolean>} whether a generation is currently running */
    async isGenerating() {
        return await this.browser.isGenerating();
    }

    /**
     * Wait until generation finishes (if any is running).
     * @param {number} [timeout=600000]
     */
    async waitForIdle(timeout = 600_000) {
        await this.browser.waitForIdle(timeout);
    }
}
