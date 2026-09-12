/**
 * Group-chat control through the live frontend: open groups, manage members,
 * mute/unmute, and trigger specific members. Group CRUD over HTTP lives in
 * src/api/groups.js; this module covers the session-side behaviors that only
 * the running frontend can perform.
 *
 * Member/name arguments go through StscriptBridge.invoke (direct callback
 * call) so names containing quotes, pipes or spaces survive verbatim.
 */

/**
 * Normalize a member reference into the positional text argument the
 * /member-* callbacks expect: a 0-based index as a string, or a name.
 * @param {string|number} member
 * @returns {string}
 */
function memberArg(member) {
    return typeof member === 'number' ? String(member) : String(member);
}

export class GroupControl {
    /**
     * @param {import('../core/browser.js').StBrowser} browser
     * @param {import('../core/stscript.js').StscriptBridge} stscript
     */
    constructor(browser, stscript) {
        this.browser = browser;
        this.stscript = stscript;
    }

    /**
     * List groups as seen by the frontend (live, includes unshallowed members).
     * @returns {Promise<Array<object>>}
     */
    async list() {
        return await this.browser.evaluate(() => {
            const ctx = SillyTavern.getContext();
            return (ctx.groups ?? []).map(g => ({
                id: g.id,
                name: g.name,
                members: [...(g.members ?? [])],
                disabledMembers: [...(g.disabled_members ?? [])],
                activationStrategy: g.activation_strategy ?? null,
                generationMode: g.generation_mode ?? null,
                allowSelfResponses: !!g.allow_self_responses,
                chatId: g.chat_id ?? null,
            }));
        });
    }

    /**
     * Open a group in the UI by id.
     *
     * NOTE (verified against group-chats.js): the full open flow is
     * openGroupById(groupId) - it selects the group, clears the chat view and
     * loads the group's current chat. openGroupChat(groupId, chatId) only
     * SWITCHES between chats of an already-open group (and silently no-ops
     * without a valid chatId), so it is used here only for the optional
     * chatId override.
     * @param {string} groupId
     * @param {object} [options]
     * @param {string} [options.chatId] specific group chat to open within the group
     * @returns {Promise<boolean>} true if the group was opened
     */
    async open(groupId, options = {}) {
        return await this.browser.evaluate(async ({ groupId, chatId }) => {
            const ctx = SillyTavern.getContext();
            const groupMod = await import('/scripts/group-chats.js');
            const opened = await groupMod.openGroupById(String(groupId));
            if (chatId) {
                await ctx.openGroupChat(String(groupId), chatId);
            }
            return !!opened || String(ctx.groupId) === String(groupId);
        }, { groupId, chatId: options.chatId ?? null });
    }

    /**
     * Add a member (character name or avatar key) to the currently open group.
     * @param {string} character
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async addMember(character) {
        return await this.stscript.invoke('member-add', { text: memberArg(character) });
    }

    /**
     * Remove a member by 0-based index or name.
     * @param {string|number} member
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async removeMember(member) {
        return await this.stscript.invoke('member-remove', { text: memberArg(member) });
    }

    /**
     * Mute a member (they stop replying in Natural/List order).
     * @param {string|number} member name or index
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async mute(member) {
        return await this.stscript.invoke('member-disable', { text: memberArg(member) });
    }

    /**
     * Unmute a member.
     * @param {string|number} member
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async unmute(member) {
        return await this.stscript.invoke('member-enable', { text: memberArg(member) });
    }

    /**
     * Move a member up/down in list order.
     * @param {'up'|'down'} direction
     * @param {string|number} member
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async moveMember(direction, member) {
        if (!['up', 'down'].includes(direction)) throw new TypeError('direction must be up|down');
        return await this.stscript.invoke(`member-${direction}`, { text: memberArg(member) });
    }

    /**
     * Read a member field (name/index/id/avatar) by name or index.
     * @param {object} options
     * @param {'name'|'index'|'id'|'avatar'} options.field
     * @param {string|number} [options.member]
     * @returns {Promise<string>}
     */
    async getMember(options) {
        const r = await this.stscript.invoke('member-get', {
            namedArgs: { field: String(options.field) },
            text: options.member === undefined ? '' : memberArg(options.member),
        });
        return r.pipe;
    }

    /** @returns {Promise<string>} member count of the open group */
    async memberCount() {
        const r = await this.stscript.invoke('member-count');
        return r.pipe;
    }

    /**
     * Force a specific member to reply now (Manual activation / directed turn).
     * Equivalent to clicking that member's "trigger" in the UI.
     * @param {string|number} member 0-based index or name
     * @param {object} [options]
     * @param {boolean} [options.await=true] wait for the reply to finish
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async trigger(member, options = {}) {
        const namedArgs = {};
        if (options.await === false) namedArgs.await = 'false';
        return await this.stscript.invoke('trigger', { namedArgs, text: memberArg(member) });
    }

    /**
     * Update group generation settings live (activation strategy, generation
     * mode, self responses, auto-mode delay) and persist them.
     * @param {string} groupId
     * @param {object} updates any subset of: activationStrategy(0-3), generationMode(0-2),
     *   allowSelfResponses(bool), autoModeDelay(number), members(string[]),
     *   disabledMembers(string[]), name(string), fav(bool),
     *   generationModeJoinPrefix(string), generationModeJoinSuffix(string)
     * @returns {Promise<void>}
     */
    async update(groupId, updates = {}) {
        await this.browser.evaluate(async ({ groupId, updates }) => {
            const ctx = SillyTavern.getContext();
            const group = (ctx.groups ?? []).find(g => String(g.id) === String(groupId));
            if (!group) throw new Error(`group ${groupId} not found in frontend`);
            if (updates.name !== undefined) group.name = updates.name;
            if (updates.members !== undefined) group.members = updates.members;
            if (updates.disabledMembers !== undefined) group.disabled_members = updates.disabledMembers;
            if (updates.activationStrategy !== undefined) group.activation_strategy = Number(updates.activationStrategy);
            if (updates.generationMode !== undefined) group.generation_mode = Number(updates.generationMode);
            if (updates.allowSelfResponses !== undefined) group.allow_self_responses = !!updates.allowSelfResponses;
            if (updates.autoModeDelay !== undefined) group.auto_mode_delay = Number(updates.autoModeDelay);
            if (updates.fav !== undefined) group.fav = !!updates.fav;
            if (updates.generationModeJoinPrefix !== undefined) group.generation_mode_join_prefix = updates.generationModeJoinPrefix;
            if (updates.generationModeJoinSuffix !== undefined) group.generation_mode_join_suffix = updates.generationModeJoinSuffix;
            const groupMod = await import('/scripts/group-chats.js');
            await groupMod.editGroup(groupId, true, false);
        }, { groupId, updates });
    }
}
