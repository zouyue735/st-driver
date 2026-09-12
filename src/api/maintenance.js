/**
 * Maintenance API wrappers for the SillyTavern server (ST 1.18.0):
 * - StatsApi    -> /api/stats        (usage statistics per character)
 * - BackupsApi  -> /api/backups/chat (automatic chat backup files)
 * - DataMaidApi -> /api/data-maid    (loose/orphaned user data cleanup)
 *
 * All endpoints are POST except GET /api/data-maid/view. Field names and
 * response shapes were verified against the server source
 * (src/endpoints/stats.js, backups.js, data-maid.js) AND a live server.
 *
 * Live quirks (also repeated at the affected methods):
 * - /api/backups/chat/delete and /chat/download answer 500 (not 400) when
 *   `name` is missing: the value goes through sanitize-filename, which throws
 *   on undefined. Both wrapper methods validate `name` client-side.
 * - POST /api/data-maid/report parses EVERY chat file server-side; on large
 *   installs it can take a long time. It also invalidates all previously
 *   issued tokens for the same user (only the newest token stays valid).
 * - data-maid error bodies are bare status texts ('Forbidden', 'Bad Request',
 *   'Not Found'), not JSON objects.
 * - /api/stats/update REPLACES the whole in-memory stats object with the body;
 *   /api/stats/recreate rescans every chat file. Both mutate user data.
 */

/**
 * Require a non-empty string argument.
 * @param {unknown} value
 * @param {string} label parameter name for the error message
 * @returns {string}
 */
function requireStr(value, label) {
    if (value === undefined || value === null) {
        throw new TypeError(`${label} is required (got ${value})`);
    }
    const str = String(value);
    if (!str.trim().length) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return str;
}

/**
 * Wrapper around the SillyTavern usage-statistics endpoints (/api/stats/*).
 *
 * The stats object maps character avatar file names ('Foo.png') to per-
 * character aggregates { total_gen_time, user_word_count, non_user_word_count,
 * user_msg_count, non_user_msg_count, total_swipe_count, chat_size,
 * date_last_chat, date_first_chat } plus a top-level `timestamp` of the last
 * generation. On a fresh instance the object may contain ONLY the timestamp.
 * The server persists the object to stats.json every 5 minutes and on exit.
 */
export class StatsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Read the current stats object.
     * Endpoint: POST /api/stats/get (no body).
     *
     * @returns {Promise<object>} stats keyed by character avatar file name,
     * always including a numeric `timestamp` (Date.now of the last
     * recreation/update); {} shaped when nothing was collected yet
     */
    async get() {
        return await this.client.post('/api/stats/get', {});
    }

    /**
     * Recreate the stats from scratch by rescanning every chat file of the
     * user. MUTATES the stored statistics (and is slow on large installs).
     * Endpoint: POST /api/stats/recreate (no body).
     *
     * @returns {Promise<string>} the plain-text 'OK' status body
     * (sendStatus(200) on success, 500 on a scan failure)
     */
    async recreate() {
        return await this.client.postRaw('/api/stats/recreate', {});
    }

    /**
     * Replace the whole stats object with the given one. MUTATES the stored
     * statistics; the server tags the payload with a fresh `timestamp` before
     * saving.
     * Endpoint: POST /api/stats/update (body IS the stats object).
     *
     * @param {object} stats the complete stats object to store
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {TypeError} client-side when stats is not a plain object (the
     * server would happily store any JSON body, e.g. a string)
     */
    async update(stats) {
        if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) {
            throw new TypeError(`StatsApi.update: a stats object is required (got ${typeof stats})`);
        }
        return await this.client.postRaw('/api/stats/update', stats);
    }
}

/**
 * Wrapper around the automatic chat-backup endpoints (/api/backups/chat/*).
 *
 * ST stores manual/automatic chat backups as 'chat_<timestamp>_<name>.jsonl'
 * files in the user's backups directory. Only files with the 'chat_' prefix
 * are visible to this API; every route rejects other names with 400 before
 * touching the disk. Settings backups live in the same directory but are out
 * of scope here.
 */
export class BackupsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * List all chat backup files with chat metadata.
     * Endpoint: POST /api/backups/chat/get (no body).
     *
     * @returns {Promise<object[]>} array of { match, file_id (name without
     * .jsonl), file_name (with .jsonl, 'chat_' prefix), file_size (humanized
     * string like '2.67KB'), chat_items, mes (last message preview), last_mes
     * (send_date string, or the mtime number for empty files) }; [] when no
     * backups exist
     * @throws {import('../core/client.js').StApiError} 500 when the backups
     * directory cannot be read
     */
    async get() {
        return await this.client.post('/api/backups/chat/get', {});
    }

    /**
     * Delete one chat backup file.
     * Endpoint: POST /api/backups/chat/delete { name }.
     *
     * @param {object} params
     * @param {string} params.name backup file name; MUST start with 'chat_'
     * (400 otherwise) - with or without the .jsonl extension
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {TypeError} client-side when name is missing or empty (the raw
     * server answers 500 in that case: sanitize-filename throws on undefined)
     * @throws {import('../core/client.js').StApiError} 400 for a non-'chat_'
     * name; 404 when the file does not exist
     */
    async delete({ name } = {}) {
        // Client-side guard: without it the server 500s instead of 400ing.
        requireStr(name, "'name'");
        return await this.client.postRaw('/api/backups/chat/delete', { name });
    }

    /**
     * Download one chat backup file as raw JSONL bytes.
     * Endpoint: POST /api/backups/chat/download { name }.
     *
     * @param {object} params
     * @param {string} params.name backup file name; MUST start with 'chat_'
     * (400 otherwise)
     * @returns {Promise<Buffer>} the backup file contents
     * @throws {TypeError} client-side when name is missing or empty (the raw
     * server answers 500 in that case)
     * @throws {import('../core/client.js').StApiError} 400 for a non-'chat_'
     * name; 404 when the file does not exist
     */
    async download({ name } = {}) {
        requireStr(name, "'name'");
        return await this.client.postBinary('/api/backups/chat/download', { name });
    }
}

/**
 * Wrapper around the Data Maid endpoints (/api/data-maid/*).
 *
 * The Data Maid finds LOOSE (orphaned) user data: images/files not referenced
 * by any chat, chats without a character, unreferenced thumbnails, and the
 * chat/settings backup files. Flow:
 *   1. report()   -> sanitized report + a single-use cleanup token
 *   2. view()     -> GET a reported file by its token+hash (read-only)
 *   3. delete()   -> unlink the reported files with the given hashes
 *   4. finalize() -> drop the token (REQUIRED hygiene: it keeps a full list of
 *                    deletable file paths in server memory)
 *
 * Server behavior verified in src/endpoints/data-maid.js:
 * - report hashes the absolute file PATHS (sha256); real paths never leave
 *   the server, only { name, hash, parent?, size?, mtime? } records.
 * - A new report INVALIDATES every previous token of the same user.
 * - Tokens are in-memory only: a server restart drops them all.
 * - delete() of unknown/out-of-root hashes is a silent no-op (204 anyway).
 * - Error bodies are bare status texts, not JSON.
 */
export class DataMaidApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Generate the loose-data report and mint a cleanup token. Can be slow:
     * the server parses every chat file to find referenced media. Invalidates
     * all older tokens of the same user.
     * Endpoint: POST /api/data-maid/report (no body).
     *
     * @returns {Promise<{report: object, token: string}>} `report` has the
     * nine categories images, files, chats, groupChats, avatarThumbnails,
     * backgroundThumbnails, personaThumbnails, chatBackups, settingsBackups,
     * each an array of { name, hash (sha256 of the file path), parent?, size?,
     * mtime? }; `token` is a 64-hex cleanup token
     * @throws {import('../core/client.js').StApiError} 403 when the request is
     * not bound to a user profile; 500 on a scan failure
     */
    async report() {
        return await this.client.post('/api/data-maid/report', {});
    }

    /**
     * Drop a cleanup token without deleting anything. Always call this when
     * done with a token (it holds deletable file paths in server memory).
     * Endpoint: POST /api/data-maid/finalize { token }.
     *
     * @param {object} params
     * @param {string} params.token token from a previous report()
     * @returns {Promise<null>} null (the server answers 204 No Content)
     * @throws {import('../core/client.js').StApiError} 400 when token is
     * missing; 403 when the token is unknown, already finalized, or belongs to
     * another user
     */
    async finalize({ token } = {}) {
        return await this.client.post('/api/data-maid/finalize', { token });
    }

    /**
     * Read one reported file's contents (preview/download in the UI). This is
     * the only GET route of the module; token+hash travel in the query string.
     * Endpoint: GET /api/data-maid/view?token=&hash=.
     *
     * @param {object} params
     * @param {string} params.token token from a previous report()
     * @param {string} params.hash the record's hash from the report
     * @returns {Promise<Buffer>} the file bytes (Content-Type is set from the
     * file extension, defaulting to text/plain)
     * @throws {import('../core/client.js').StApiError} 400 when token or hash
     * is missing; 403 for an unknown/foreign token or a path outside the user
     * root; 404 when the hash is not part of the report or the file is gone
     */
    async view({ token, hash } = {}) {
        const query = new URLSearchParams({ token: String(token ?? ''), hash: String(hash ?? '') });
        // NOTE: the server checks `!req.query.token`, so an empty string still
        // lands in the 400 branch - no client-side validation needed.
        return await this.client.getBinary(`/api/data-maid/view?${query}`);
    }

    /**
     * Delete the reported files with the given hashes. DESTRUCTIVE: the
     * server unlinks each matching file. Unknown hashes, paths outside the
     * user root and already-missing files are skipped silently.
     * Endpoint: POST /api/data-maid/delete { token, hashes }.
     *
     * @param {object} params
     * @param {string} params.token token from a previous report()
     * @param {string[]} params.hashes record hashes to delete (non-empty)
     * @returns {Promise<null>} null (the server answers 204 No Content)
     * @throws {import('../core/client.js').StApiError} 400 when token is
     * missing or hashes is not a non-empty array; 403 for an unknown/foreign
     * token
     */
    async delete({ token, hashes } = {}) {
        return await this.client.post('/api/data-maid/delete', { token, hashes });
    }
}
