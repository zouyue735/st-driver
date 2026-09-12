/**
 * Chat control through the live frontend: read messages, inject messages as
 * user / narrator / character / hidden comment, delete / rewind, swipes.
 *
 * Reads go through ctx.chat (the authoritative in-memory chat array).
 * Writes go through STscript (/send, /sendas, /sys, /comment, /del) so that
 * rendering, metadata and debounced persistence all behave exactly like the UI.
 *
 * @typedef {object} ChatMessage
 * @property {string} name sender display name
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string|number} send_date
 * @property {string} mes message text (macros already substituted)
 * @property {object} [extra]
 * @property {string[]} [swipes]
 * @property {number} [swipe_id]
 */

/**
 * Build the named-args object for a message command from the caller options.
 * @param {object} options {compact?, at?, name?}
 * @returns {Record<string, any>}
 */
function messageArgs(options = {}) {
    const args = {};
    if (options.compact !== undefined) args.compact = String(!!options.compact);
    if (options.at !== undefined) args.at = String(Number(options.at));
    if (options.name !== undefined) args.name = String(options.name);
    return args;
}

export class ChatControl {
    /**
     * @param {import('../core/browser.js').StBrowser} browser
     * @param {import('../core/stscript.js').StscriptBridge} stscript
     */
    constructor(browser, stscript) {
        this.browser = browser;
        this.stscript = stscript;
    }

    /**
     * Read the current chat as plain objects.
     * @param {object} [options]
     * @param {boolean} [options.includeSystem=false] include hidden system/comment messages
     * @returns {Promise<ChatMessage[]>}
     */
    async read(options = {}) {
        const includeSystem = options.includeSystem ?? false;
        return await this.browser.evaluate(({ includeSystem }) => {
            const ctx = SillyTavern.getContext();
            return (ctx.chat ?? [])
                .map((m, index) => ({
                    index,
                    name: m.name ?? null,
                    is_user: !!m.is_user,
                    is_system: !!m.is_system,
                    send_date: m.send_date ?? null,
                    mes: m.mes ?? '',
                    swipes: Array.isArray(m.swipes) ? m.swipes.length : 0,
                    swipe_id: m.swipe_id ?? null,
                    extraKeys: m.extra ? Object.keys(m.extra) : [],
                }))
                .filter(m => includeSystem || !(m.is_system && m.mes !== ''));
        }, { includeSystem });
    }

    /** @returns {Promise<number>} message count */
    async length() {
        return await this.browser.evaluate(() => SillyTavern.getContext().chat?.length ?? 0);
    }

    /** @returns {Promise<ChatMessage|null>} the last message, or null */
    async last() {
        const all = await this.read({ includeSystem: true });
        return all.length ? all[all.length - 1] : null;
    }

    /**
     * Send a message as the current persona (user). Does NOT trigger generation.
     *
     * The text is handed to the command callback directly (no STscript text
     * parsing), so pipes, quotes, backslashes and `name=`-looking content all
     * survive verbatim.
     * @param {string} text
     * @param {object} [options]
     * @param {boolean} [options.compact=false] render as a compact one-line message
     * @param {number} [options.at] insert position (negative counts from the end)
     * @param {string} [options.name] sender display name (default: the persona)
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async sendUser(text, options = {}) {
        return await this.stscript.invoke('send', { namedArgs: messageArgs(options), text: String(text ?? '') });
    }

    /**
     * Send a message as a specific character (or the current character with {{char}}).
     * Does NOT trigger generation.
     * @param {string} name character name or avatar key; '{{char}}' for the current character
     * @param {string} text
     * @param {object} [options]
     * @param {boolean} [options.compact=false]
     * @param {number} [options.at] insert position
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async sendAs(name, text, options = {}) {
        if (name === undefined || name === null || !String(name).length) {
            throw new TypeError('ChatControl.sendAs: name is required (use "{{char}}" for the current character)');
        }
        return await this.stscript.invoke('sendas', {
            namedArgs: { ...messageArgs(options), name: String(name) },
            text: String(text ?? ''),
        });
    }

    /**
     * Send a neutral narrator message: visible in the chat AND included in the
     * prompt. NOTE (verified): narrator messages carry `is_system=false` —
     * only sendComment produces hidden `is_system=true` messages.
     * @param {string} text
     * @param {object} [options]
     * @param {boolean} [options.compact=false]
     * @param {number} [options.at] insert position
     * @param {string} [options.name] narrator display name
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async sendNarrator(text, options = {}) {
        return await this.stscript.invoke('sys', { namedArgs: messageArgs(options), text: String(text ?? '') });
    }

    /**
     * Send a hidden comment: visible in the UI, EXCLUDED from prompts
     * (`is_system=true`, sender name "Note").
     * @param {string} text
     * @param {object} [options]
     * @param {boolean} [options.compact=false]
     * @param {number} [options.at] insert position
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async sendComment(text, options = {}) {
        return await this.stscript.invoke('comment', { namedArgs: messageArgs(options), text: String(text ?? '') });
    }

    /**
     * Delete the last N messages from the chat.
     * @param {number} [count=1]
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async deleteLast(count = 1) {
        return await this.stscript.invoke('del', { text: String(Number(count)) });
    }

    /**
     * Delete a message by its index (0-based, includes hidden messages).
     * Uses the frontend deleteMessage (handles swipes and re-render).
     * @param {number} index
     * @returns {Promise<void>}
     */
    async deleteAt(index) {
        await this.browser.evaluate(async ({ index }) => {
            const ctx = SillyTavern.getContext();
            await ctx.deleteMessage(index, undefined, false);
        }, { index });
    }

    /**
     * Cut messages by index or inclusive range, e.g. '5' or '3-8'.
     * @param {string|number} range
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async cut(range) {
        return await this.stscript.invoke('cut', { text: String(range) });
    }

    /**
     * Read messages by index or range through /messages (excludes hidden).
     * @param {string|number} range e.g. 5 or '2-7'
     * @param {object} [options]
     * @param {boolean} [options.names=false] prefix each line with the sender name
     * @returns {Promise<string>}
     */
    async messages(range, options = {}) {
        const namedArgs = {};
        if (options.names) namedArgs.names = 'on';
        const r = await this.stscript.invoke('messages', { namedArgs, text: String(range) });
        return r.pipe;
    }

    /**
     * Swipe the last character message left or right.
     * @param {'left'|'right'} direction
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async swipe(direction) {
        if (!['left', 'right'].includes(direction)) {
            throw new TypeError(`ChatControl.swipe: direction must be 'left' or 'right', got ${direction}`);
        }
        return await this.stscript.invoke('swipe', { namedArgs: { direction } });
    }

    /**
     * Add an extra swipe (alternative reply) to the last character message.
     * @param {string} text
     * @param {object} [options]
     * @param {boolean} [options.switchTo=false] immediately switch to the new swipe
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async addSwipe(text, options = {}) {
        const namedArgs = {};
        if (options.switchTo) namedArgs.switch = 'true';
        return await this.stscript.invoke('addswipe', { namedArgs, text: String(text ?? '') });
    }

    /**
     * Delete a swipe from the last character message (1-based swipe number).
     * @param {number} swipeNumber
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async deleteSwipe(swipeNumber) {
        return await this.stscript.invoke('delswipe', { text: String(Number(swipeNumber)) });
    }

    /**
     * Rename a message's displayed sender, or change its role.
     * @param {number} id message index
     * @param {object} update {name?, role?} role: 'user'|'assistant'|'system'
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async editMessageMeta(id, update = {}) {
        if (update.name !== undefined) {
            const r = await this.stscript.invoke('message-name', {
                namedArgs: { id: String(Number(id)) },
                text: String(update.name),
            });
            if (r.isError) return r;
        }
        if (update.role !== undefined) {
            return await this.stscript.invoke('message-role', {
                namedArgs: { id: String(Number(id)) },
                text: String(update.role),
            });
        }
        return { pipe: '', isError: false, errorMessage: null, interrupt: false, isAborted: false };
    }

    /**
     * Open a character's chat by character id; optionally a specific chat file.
     * @param {number} characterId index into ctx.characters
     * @param {string} [chatFileName] e.g. 'Name - 2026-01-01.jsonl' (without extension handling by ST)
     * @returns {Promise<void>}
     */
    async openCharacter(characterId, chatFileName = null) {
        await this.browser.evaluate(async ({ characterId, chatFileName }) => {
            const ctx = SillyTavern.getContext();
            await ctx.selectCharacterById(characterId, { switchMenu: false });
            if (chatFileName) {
                await ctx.openCharacterChat(chatFileName);
            }
        }, { characterId, chatFileName });
    }

    /**
     * Open a character by exact name (fails if not found).
     * @param {string} name
     * @returns {Promise<void>}
     */
    async openCharacterByName(name) {
        const r = await this.stscript.invoke('go', { text: String(name) });
        if (r.isError) throw new Error(`openCharacterByName(${name}) failed: ${r.errorMessage}`);
    }

    /**
     * Start a brand-new chat with the current character (UI "New chat").
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async newChat() {
        return await this.stscript.invoke('newchat');
    }

    /** @returns {Promise<void>} close the current chat */
    async closeChat() {
        await this.stscript.invoke('closechat');
    }

    /**
     * Rename the current chat file.
     * @param {string} newName without extension
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async renameChat(newName) {
        return await this.stscript.invoke('renamechat', { text: String(newName) });
    }

    /**
     * List chat variables of the current chat.
     * @returns {Promise<Record<string, any>>}
     */
    async listVariables() {
        return await this.browser.evaluate(() => {
            const ctx = SillyTavern.getContext();
            return JSON.parse(JSON.stringify(ctx.chatMetadata?.variables ?? {}));
        });
    }
}
