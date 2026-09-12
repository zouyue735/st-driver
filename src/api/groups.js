/**
 * Groups API driver for SillyTavern 1.18.0.
 *
 * Endpoints (verified against src/endpoints/groups.js and the group/*
 * routes of src/endpoints/chats.js):
 *   POST /api/groups/all      -> group array (each group enriched with
 *                                date_added/create_date/date_last_chat/chat_size)
 *   POST /api/groups/create   -> full group object (server generates id)
 *   POST /api/groups/edit     -> { ok: true }   (whole-object overwrite)
 *   POST /api/groups/delete   -> { ok: true }   (cascades to group chat files)
 *   POST /api/chats/group/get    -> message array (header line first)
 *   POST /api/chats/group/save   -> { ok: true }
 *   POST /api/chats/group/info   -> chat file metadata
 *   POST /api/chats/group/delete -> { ok: true }
 *
 * Observed quirks:
 * - create() drops `fav` and `avatar_url` when they are not provided
 *   (JSON.stringify omits undefined -> keys absent from the stored object).
 * - delete() returns { ok: true } even for a non-existent id.
 * - getChat() of a non-existent chat returns [] with status 200, while
 *   deleteChat() of a non-existent chat returns 400.
 */

/** Group activation strategy enum (group_activation_strategy in ST). */
export const GroupActivationStrategy = Object.freeze({
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
});

/** Group generation mode enum (group_generation_mode in ST). */
export const GroupGenerationMode = Object.freeze({
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
});

/**
 * @typedef {object} Group
 * @property {string} id server-generated String(Date.now())
 * @property {string} name defaults to 'New Group' on create
 * @property {string[]} members character avatar file names (e.g. 'Name.png')
 * @property {string} [avatar_url] group avatar file name
 * @property {boolean} allow_self_responses
 * @property {number} activation_strategy 0=NATURAL, 1=LIST, 2=MANUAL, 3=POOLED
 * @property {number} generation_mode 0=SWAP, 1=APPEND, 2=APPEND_DISABLED
 * @property {string[]} disabled_members
 * @property {boolean} [fav]
 * @property {string} chat_id currently active chat (defaults to the group id)
 * @property {string[]} chats all chat ids (defaults to [id])
 * @property {number} auto_mode_delay seconds, defaults to 5
 * @property {string} generation_mode_join_prefix
 * @property {string} generation_mode_join_suffix
 * @property {string} [create_date] ISO string added by /api/groups/all
 */

/**
 * @typedef {object} GroupChatHeader
 * @property {object} chat_metadata per-chat metadata (integrity slug lives here)
 * @property {string} user_name conventionally 'unused' for group chats
 * @property {string} character_name conventionally 'unused' for group chats
 */

/**
 * @typedef {object} GroupChatMessage
 * @property {string} name speaker (user name or character name)
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string|number} send_date ISO timestamp (or legacy numeric date)
 * @property {string} mes message text
 * @property {object} [extra]
 */

export class GroupsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/groups/all - list every group.
     * @returns {Promise<Group[]>} groups, each enriched with date_added,
     * create_date, date_last_chat and chat_size from file stats
     */
    async all() {
        return await this.client.post('/api/groups/all', {});
    }

    /**
     * POST /api/groups/create - create a group.
     * The body is the group fields without id; the server generates
     * String(Date.now()) and applies defaults (name 'New Group',
     * activation_strategy 0, generation_mode 0, auto_mode_delay 5,
     * chat_id = id, chats = [id]).
     * @param {Partial<Group>} [group] group fields to set
     * @returns {Promise<Group>} the complete stored group object, including id
     */
    async create(group = {}) {
        return await this.client.post('/api/groups/create', group);
    }

    /**
     * POST /api/groups/edit - overwrite a group definition.
     * The body is the COMPLETE group object (it replaces <id>.json wholesale;
     * omitted fields are lost). Read via all() first, mutate, then edit().
     * @param {Group} group full group object, must include id
     * @returns {Promise<{ok: boolean}>}
     */
    async edit(group) {
        return await this.client.post('/api/groups/edit', group);
    }

    /**
     * POST /api/groups/delete - delete a group and its chat files.
     * @param {string} id group id
     * @returns {Promise<{ok: boolean}>} ok even if the id did not exist
     */
    async delete(id) {
        return await this.client.post('/api/groups/delete', { id });
    }

    /**
     * POST /api/chats/group/get - read a group chat transcript.
     * @param {string} chatId chat id (file <chatId>.jsonl in group chats dir)
     * @returns {Promise<Array<GroupChatHeader|GroupChatMessage>>} header line
     * first, then messages; [] when the file does not exist
     */
    async getChat(chatId) {
        return await this.client.post('/api/chats/group/get', { id: chatId });
    }

    /**
     * POST /api/chats/group/save - write a group chat transcript (full replace).
     * @param {string} chatId chat id
     * @param {Array<GroupChatHeader|GroupChatMessage>} chat header + messages;
     * the header is { chat_metadata: {}, user_name: 'unused', character_name: 'unused' }
     * @param {boolean} [force=false] skip the chat integrity check
     * @returns {Promise<{ok: boolean}>}
     */
    async saveChat(chatId, chat, force = false) {
        return await this.client.post('/api/chats/group/save', { id: chatId, chat, force });
    }

    /**
     * POST /api/chats/group/info - metadata about a group chat file.
     * @param {string} chatId chat id
     * @returns {Promise<{file_id: string, file_name: string, file_size: string,
     * chat_items: number, mes: string, last_mes: string|number, match: boolean}>}
     * chat_items excludes the header line; mes/last_mes describe the last message
     */
    async chatInfo(chatId) {
        return await this.client.post('/api/chats/group/info', { id: chatId });
    }

    /**
     * POST /api/chats/group/delete - delete a single group chat file.
     * @param {string} chatId chat id
     * @returns {Promise<{ok: boolean}>}
     * @throws {import('../core/client.js').StApiError} 400 when the file does not exist
     */
    async deleteChat(chatId) {
        return await this.client.post('/api/chats/group/delete', { id: chatId });
    }
}
