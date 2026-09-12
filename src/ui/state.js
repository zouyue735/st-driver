/**
 * UI state guard: captures and restores the frontend's navigation context
 * (open chat, persona, background), so driver operations can be made
 * non-destructive to whatever the user had open.
 *
 * Live values (user_avatar, background_settings) are read through dynamic
 * imports of their owning modules to get ESM live bindings.
 */
export class StateGuard {
    /** @param {import('../core/browser.js').StBrowser} browser */
    constructor(browser) {
        this.browser = browser;
    }

    /**
     * Snapshot the current UI context.
     * @returns {Promise<{characterId:number|null, groupId:string|null, chatId:string|null,
     *   userAvatar:string|null, userName:string|null, background:object|null}>}
     */
    async save() {
        return await this.browser.evaluate(async () => {
            const ctx = SillyTavern.getContext();
            const personas = await import('/scripts/personas.js');
            const backgrounds = await import('/scripts/backgrounds.js');
            return {
                characterId: ctx.characterId ?? null,
                groupId: ctx.groupId ?? null,
                chatId: ctx.chatId ?? null,
                userAvatar: personas.user_avatar || null,
                userName: ctx.name1 ?? null,
                background: JSON.parse(JSON.stringify(backgrounds.background_settings ?? null)),
            };
        });
    }

    /**
     * Restore a previously saved UI context (reopen the same chat / persona).
     * @param {Awaited<ReturnType<StateGuard['save']>>} state
     * @returns {Promise<void>}
     */
    async restore(state) {
        if (!state) return;
        await this.browser.evaluate(async ({ state }) => {
            const ctx = SillyTavern.getContext();
            const personas = await import('/scripts/personas.js');
            // persona
            if (state.userAvatar && personas.user_avatar !== state.userAvatar) {
                await personas.setUserAvatar(state.userAvatar, { toastPersonaNameChange: false }).catch(() => {});
            }
            // group chat: full open flow is openGroupById; openGroupChat only
            // switches chats inside an already-open group (needs a real chatId)
            if (state.groupId) {
                if (String(ctx.groupId) !== String(state.groupId)) {
                    const groupMod = await import('/scripts/group-chats.js');
                    await groupMod.openGroupById(String(state.groupId)).catch(() => {});
                }
                if (state.chatId && String(ctx.chatId) !== String(state.chatId)) {
                    await ctx.openGroupChat(String(state.groupId), state.chatId).catch(() => {});
                }
                return;
            }
            // single character chat
            if (state.characterId !== null && state.characterId !== undefined) {
                if (ctx.characterId !== state.characterId) {
                    await ctx.selectCharacterById(state.characterId, { switchMenu: false }).catch(() => {});
                }
                if (state.chatId && ctx.chatId !== state.chatId) {
                    await ctx.openCharacterChat(state.chatId).catch(() => {});
                }
            }
        }, { state });
    }
}
