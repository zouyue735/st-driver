/**
 * Bridge for executing STscript (slash commands) in the live frontend.
 *
 * STscript only runs in the browser (no server-side endpoint exists), so every
 * call goes through page.evaluate -> ctx.executeSlashCommandsWithOptions().
 * This covers the entire documented command surface (~290 commands), including
 * UI-only features like /gen, /trigger, /persona-set, /member-add.
 */

/**
 * @typedef {object} StscriptResult
 * @property {string} pipe final pipe value (what the script "returned")
 * @property {boolean} isError whether execution failed
 * @property {string|null} errorMessage failure detail when isError
 * @property {boolean} interrupt whether the script interrupted (e.g. /abort, popup dismissal)
 * @property {boolean} isAborted whether the script was aborted
 */

export class StscriptBridge {
    /** @param {import('./browser.js').StBrowser} browser */
    constructor(browser) {
        this.browser = browser;
    }

    /**
     * Execute an STscript string and resolve when it finishes.
     * @param {string} script e.g. '/setvar key=foo bar'
     * @param {object} [options]
     * @param {boolean} [options.handleExecutionErrors=true] capture errors into the result
     * @param {boolean} [options.strict=false] when true, parser errors (unknown command,
     *   syntax) reject instead of showing a toast and returning an empty result
     * @returns {Promise<StscriptResult>}
     */
    async run(script, options = {}) {
        if (typeof script !== 'string' || !script.length) {
            throw new TypeError('StscriptBridge.run: script must be a non-empty string');
        }
        return await this.browser.evaluate(async ({ script, handleExecutionErrors, strict }) => {
            const ctx = SillyTavern.getContext();
            const result = await ctx.executeSlashCommandsWithOptions(script, {
                handleExecutionErrors,
                handleParserErrors: !strict,
            });
            return {
                pipe: result?.pipe ?? '',
                isError: !!result?.isError,
                errorMessage: result?.errorMessage ?? null,
                interrupt: !!result?.interrupt,
                isAborted: !!result?.isAborted,
            };
        }, {
            script,
            handleExecutionErrors: options.handleExecutionErrors ?? true,
            strict: options.strict ?? false,
        });
    }

    /**
     * Execute STscript and throw on error (convenience wrapper).
     * @param {string} script
     * @param {object} [options] forwarded to run()
     * @returns {Promise<string>} the pipe value
     */
    async runOrThrow(script, options = {}) {
        const r = await this.run(script, options);
        if (r.isError) {
            throw new Error(`STscript failed for "${script}": ${r.errorMessage ?? 'unknown error'}`);
        }
        if (r.isAborted) {
            throw new Error(`STscript aborted for "${script}": ${r.errorMessage ?? 'aborted'}`);
        }
        return r.pipe;
    }

    /**
     * Invoke a registered command's callback DIRECTLY, bypassing the STscript
     * text parser entirely.
     *
     * This is the safe way to pass arbitrary literal text into a command:
     * values arrive as real JS strings instead of being re-parsed, so pipes,
     * quotes, backslashes, `name=`-looking text and newlines all survive
     * verbatim (verified live: 9/9 adversarial cases round-trip exactly).
     *
     * Use {@link run} when you need actual script semantics (pipes, closures,
     * macros); use `invoke` when you need to hand a command exact data.
     *
     * @param {string} commandName e.g. 'comment', 'send', 'sendas', 'sys'
     * @param {object} [options]
     * @param {Record<string, any>} [options.namedArgs] named arguments
     *   (e.g. {compact: true, at: 0, name: 'Bob'})
     * @param {string} [options.text] the positional/unnamed argument
     * @returns {Promise<StscriptResult>}
     */
    async invoke(commandName, options = {}) {
        const namedArgs = options.namedArgs ?? {};
        const text = options.text;
        return await this.browser.evaluate(async ({ commandName, namedArgs, hasText, text }) => {
            const ctx = SillyTavern.getContext();
            const command = ctx.SlashCommandParser.commands[commandName];
            if (!command) {
                return {
                    pipe: '', isError: true,
                    errorMessage: `unknown command '/${commandName}' (not in the live registry)`,
                    interrupt: false, isAborted: false,
                };
            }
            // Mirror the arg object the closure builds for a callback. `_scope`
            // is only needed by commands that read script-scope variables; the
            // message/state commands work with it unset (verified).
            const args = {
                _scope: null,
                _parserFlags: null,
                _abortController: null,
                _debugController: null,
                ...namedArgs,
            };
            try {
                const pipe = await command.callback(args, hasText ? text : '');
                return {
                    pipe: pipe === undefined || pipe === null ? '' : String(pipe),
                    isError: false, errorMessage: null, interrupt: false, isAborted: false,
                };
            } catch (e) {
                return {
                    pipe: '', isError: true,
                    errorMessage: String(e?.message ?? e),
                    interrupt: false, isAborted: false,
                };
            }
        }, { commandName, namedArgs, hasText: text !== undefined, text });
    }

    /**
     * Dump the live slash-command registry: every command registered by the
     * running frontend (core + all loaded extensions).
     * @returns {Promise<Array<{name:string, aliases:string[], named:string[], unnamed:string[], help:string, source:string}>>}
     */
    async listCommands() {
        return await this.browser.evaluate(() => {
            // use the LIVE registry via getContext(); a fresh dynamic import
            // would create a second module instance that never got initialized
            const ctx = SillyTavern.getContext();
            const commands = ctx.SlashCommandParser.commands;
            const out = [];
            const entries = commands instanceof Map ? commands.entries() : Object.entries(commands);
            for (const [name, cmd] of entries) {
                out.push({
                    name,
                    aliases: Array.isArray(cmd.aliases) ? [...cmd.aliases] : [],
                    named: Array.isArray(cmd.namedArgumentList) ? cmd.namedArgumentList.map(a => a.name) : [],
                    unnamed: Array.isArray(cmd.unnamedArgumentList) ? cmd.unnamedArgumentList.map(a => a.name) : [],
                    help: typeof cmd.helpString === 'string' ? cmd.helpString : '',
                    source: cmd.source?.name ?? cmd.source?.toString?.() ?? '',
                });
            }
            return out;
        });
    }

    /**
     * Subscribe to a frontend event; returns a subscription id. Events are
     * buffered on window.__stDriverEvents for later polling (EventEmitter
     * instances are not serializable across the evaluate boundary).
     * @param {string} eventType e.g. 'MESSAGE_RECEIVED' (key of ctx.eventTypes)
     * @returns {Promise<number>} subscription id
     */
    async subscribe(eventType) {
        return await this.browser.evaluate(({ eventType }) => {
            const ctx = SillyTavern.getContext();
            window.__stDriverEvents ??= { seq: 0, subs: {}, buffer: {} };
            const registry = window.__stDriverEvents;
            const ev = ctx.eventTypes[eventType] ?? eventType;
            const id = ++registry.seq;
            registry.buffer[id] = [];
            registry.subs[id] = { event: ev };
            ctx.eventSource.on(ev, (detail) => {
                registry.buffer[id].push({
                    at: new Date().toISOString(),
                    detail: (() => {
                        try { return JSON.parse(JSON.stringify(detail ?? null)); } catch { return String(detail); }
                    })(),
                });
            });
            return id;
        }, { eventType });
    }

    /**
     * Drain buffered events for a subscription (returns and clears the buffer).
     * @param {number} id subscription id from subscribe()
     * @returns {Promise<Array<{at:string, detail:any}>>}
     */
    async pollEvents(id) {
        return await this.browser.evaluate(({ id }) => {
            const registry = window.__stDriverEvents;
            if (!registry?.buffer?.[id]) return [];
            const events = registry.buffer[id];
            registry.buffer[id] = [];
            return events;
        }, { id });
    }

    /**
     * Remove a subscription (best effort; buffer cleared).
     * @param {number} id
     * @returns {Promise<void>}
     */
    async unsubscribe(id) {
        await this.browser.evaluate(({ id }) => {
            const registry = window.__stDriverEvents;
            if (!registry) return;
            delete registry.buffer[id];
            delete registry.subs[id];
        }, { id });
    }
}
