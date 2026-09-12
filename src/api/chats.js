/**
 * Chats API wrapper for the SillyTavern server (ST 1.18.0).
 *
 * All endpoints are POST under /api/chats/*. Field names and response shapes
 * were verified against the server source (src/endpoints/chats.js) AND a
 * live server. Group chat routes (/api/chats/group/*) are out of scope.
 *
 * Chat file layout: a chat is a JSONL file stored under the character's chat
 * directory (named after the avatar file without .png). Line 0 is the header
 * { chat_metadata, user_name: 'unused', character_name: 'unused' }; every
 * following line is a message object { name, is_user, is_system, send_date,
 * mes, extra } plus optional swipe fields (swipes[], swipe_info[], swipe_id).
 *
 * Extension quirks (verified live - this wrapper normalizes them):
 * - /save and /get ALWAYS append '.jsonl' to file_name, so passing
 *   'x.jsonl' would silently operate on 'x.jsonl.jsonl'. This wrapper
 *   strips a trailing '.jsonl' before sending.
 * - /rename does NOT append '.jsonl' to renamed_file. Renaming to a bare
 *   name succeeds (200) but stores a file without extension that no chat
 *   listing can see anymore. This wrapper appends '.jsonl' to both
 *   original_file and renamed_file when missing.
 * - /export expects `file` WITH the '.jsonl' extension (404 otherwise);
 *   this wrapper appends it when missing.
 * - /delete appends '.jsonl' itself when chatfile has no extension at all,
 *   so the value is forwarded as-is.
 * - /search reports `file_name` WITHOUT the extension (it is the file_id),
 *   unlike /api/characters/chats which includes it.
 * - /export without `exportfilename` answers with the literal message
 *   'Chat saved to undefined'.
 * - /import runs the body fields through sanitize-filename, which THROWS on
 *   undefined; this wrapper always sends character_name/user_name (empty
 *   string makes the server fall back to 'Character'/'User').
 */

const CHATS_BASE = '/api/chats';

/**
 * Require a non-empty file name argument. Without this, `String(undefined)`
 * would produce the literal 'undefined.jsonl' and silently operate on a bogus
 * file instead of failing fast (verified: the server happily accepts it).
 * @param {unknown} value
 * @param {string} label parameter name for the error message
 * @returns {string}
 */
function requireName(value, label) {
    if (value === undefined || value === null) {
        throw new TypeError(`ChatsApi: '${label}' is required (got ${value})`);
    }
    const str = String(value);
    if (!str.trim().length) {
        throw new TypeError(`ChatsApi: '${label}' must be a non-empty string`);
    }
    return str;
}

/** Strip a trailing '.jsonl' from a chat file name (for /save and /get). */
function stripJsonl(name) {
    return requireName(name, 'fileName').replace(/\.jsonl$/, '');
}

/** Append '.jsonl' to a chat file name if missing (for /rename and /export). */
function ensureJsonl(name, label = 'file') {
    const str = requireName(name, label);
    return str.endsWith('.jsonl') ? str : `${str}.jsonl`;
}

/**
 * High-level wrapper around the SillyTavern chat endpoints (character chats
 * only; group chats are not covered).
 */
export class ChatsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Save (create or overwrite) a chat file for a character.
     * Endpoint: POST /api/chats/save { avatar_url, file_name, chat, force }.
     *
     * @param {object} params
     * @param {string} params.avatarUrl character avatar file name, e.g. 'Foo.png'
     * @param {string} params.fileName chat file name with or without the
     * '.jsonl' extension (a trailing '.jsonl' is stripped before sending)
     * @param {object[]} params.chat the full chat: element 0 is the header
     * { chat_metadata, user_name: 'unused', character_name: 'unused' },
     * followed by message objects { name, is_user, is_system, send_date,
     * mes, extra } with optional swipe fields (swipes, swipe_info, swipe_id)
     * @param {boolean} [params.force] skip the server-side chat integrity
     * check (only relevant when the chat carries an integrity slug)
     * @returns {Promise<{ok: true}>}
     * @throws {TypeError} client-side when avatarUrl/fileName is missing or empty
     * @throws {import('../core/client.js').StApiError} 400 when chat is not an
     * array, or on an integrity mismatch
     */
    async save({ avatarUrl, fileName, chat, force }) {
        requireName(avatarUrl, 'avatarUrl');
        // `chat` is deliberately NOT validated here: the server answers a
        // descriptive 400 ('... is not an array'), so passing it through keeps
        // that real API behavior observable and testable.
        const body = {
            avatar_url: avatarUrl,
            file_name: stripJsonl(fileName),
            chat,
        };
        if (force !== undefined) {
            body.force = force;
        }
        return await this.client.post(`${CHATS_BASE}/save`, body);
    }

    /**
     * Read a chat file back as an array (header + messages).
     * Endpoint: POST /api/chats/get { avatar_url, file_name }.
     *
     * @param {object} params
     * @param {string} params.avatarUrl character avatar file name
     * @param {string} [params.fileName] chat file name with or without the
     * '.jsonl' extension
     * @returns {Promise<object[]|object>} the parsed JSONL lines (element 0
     * is the header). ST quirks, all HTTP 200: {} when fileName is omitted,
     * when the avatar has no chat directory (the directory is then created),
     * or when the avatar is unknown; [] when the chat file does not exist.
     * @throws {import('../core/client.js').StApiError} 400 when avatar_url
     * contains a forbidden character
     */
    async get({ avatarUrl, fileName }) {
        const body = { avatar_url: avatarUrl };
        if (fileName !== undefined) {
            body.file_name = stripJsonl(fileName);
        }
        return await this.client.post(`${CHATS_BASE}/get`, body);
    }

    /**
     * Rename (move) a chat file within the character's chat directory.
     * Endpoint: POST /api/chats/rename
     * { avatar_url, original_file, renamed_file, is_group }.
     * '.jsonl' is appended to both file names when missing (the server does
     * NOT append it to renamed_file, which would store an unlistable file).
     *
     * @param {object} params
     * @param {string} params.avatarUrl character avatar file name
     * @param {string} params.originalFile existing chat file name (.jsonl optional)
     * @param {string} params.renamedFile new chat file name (.jsonl optional)
     * @param {boolean} [params.isGroup=false] rename inside the GROUP chats
     * directory instead of the character directory (group routes are
     * otherwise out of scope for this wrapper)
     * @returns {Promise<{ok: true, sanitizedFileName: string}>}
     * sanitizedFileName is the new name WITHOUT the .jsonl extension
     * @throws {TypeError} client-side when avatarUrl/originalFile/renamedFile
     * is missing (the wrapper fails fast instead of sending 'undefined.jsonl')
     * @throws {import('../core/client.js').StApiError} 400 when the source does
     * not exist or the destination already exists
     */
    async rename({ avatarUrl, originalFile, renamedFile, isGroup = false }) {
        requireName(avatarUrl, 'avatarUrl');
        return await this.client.post(`${CHATS_BASE}/rename`, {
            avatar_url: avatarUrl,
            original_file: ensureJsonl(originalFile, 'originalFile'),
            renamed_file: ensureJsonl(renamedFile, 'renamedFile'),
            is_group: isGroup,
        });
    }

    /**
     * Delete a chat file.
     * Endpoint: POST /api/chats/delete { avatar_url, chatfile }.
     *
     * @param {object} params
     * @param {string} params.avatarUrl character avatar file name
     * @param {string} params.chatFile chat file name; the server appends
     * '.jsonl' automatically when the name has no extension at all
     * @returns {Promise<{ok: true}>}
     * @throws {import('../core/client.js').StApiError} 400 when the file does
     * not exist (or could not be deleted)
     */
    async delete({ avatarUrl, chatFile }) {
        return await this.client.post(`${CHATS_BASE}/delete`, {
            avatar_url: avatarUrl,
            chatfile: chatFile,
        });
    }

    /**
     * Search chats of one character by content (or list them all without a
     * query). Matching is case-insensitive; the query is split on whitespace
     * and every fragment must appear in some message (or the file name).
     * Endpoint: POST /api/chats/search { query, avatar_url }.
     *
     * @param {object} params
     * @param {string} [params.query] search text; omit for "list all chats
     * of this character"
     * @param {string} params.avatarUrl character avatar file name
     * @returns {Promise<object[]>} array of { file_name (WITHOUT .jsonl -
     * this is the file_id), file_size, message_count, last_mes,
     * preview_message }; [] when nothing matches or the character has no
     * chat directory
     * @throws {import('../core/client.js').StApiError} 400 when avatar_url
     * contains a forbidden character
     */
    async search({ query, avatarUrl }) {
        const body = { avatar_url: avatarUrl };
        if (query !== undefined) {
            body.query = query;
        }
        return await this.client.post(`${CHATS_BASE}/search`, body);
    }

    /**
     * List the most recently modified chats across ALL characters and groups,
     * sorted by mtime (newest first).
     * Endpoint: POST /api/chats/recent { max, metadata }.
     *
     * @param {object} [params]
     * @param {number} [params.max] maximum number of chats to return
     * (default: no limit)
     * @param {boolean} [params.metadata=false] include each chat's
     * chat_metadata in the result
     * @returns {Promise<object[]>} array of { file_id, file_name (WITH
     * .jsonl), file_size, chat_items, mes, last_mes, match, avatar?,
     * group?, [chat_metadata] }; character chats carry `avatar` (the
     * character's avatar file name), group chats carry `group` (the group id)
     * @throws {import('../core/client.js').StApiError} 500 on a server-side
     * directory scan failure
     */
    async recent({ max, metadata = false } = {}) {
        const body = { metadata };
        if (max !== undefined) {
            body.max = max;
        }
        return await this.client.post(`${CHATS_BASE}/recent`, body);
    }

    /**
     * Export a chat file as raw JSONL text or rendered plain text.
     * Endpoint: POST /api/chats/export { file, avatar_url, format, exportfilename }.
     * The 'txt' format renders 'name: message' blocks and skips is_system
     * messages. '.jsonl' is appended to `file` when missing (the server
     * needs the real file name).
     *
     * @param {object} params
     * @param {string} params.file chat file name (.jsonl optional)
     * @param {string} params.avatarUrl character avatar file name
     * @param {'jsonl'|'txt'} params.format export format
     * @param {string} [params.exportfilename] cosmetic name echoed into the
     * response message; without it the message is literally
     * 'Chat saved to undefined' (ST quirk)
     * @returns {Promise<{message: string, result: string}>}
     * @throws {import('../core/client.js').StApiError} 400 when file (or, for
     * non-group exports, avatar_url) is missing; 404 when the chat file does
     * not exist
     */
    async export({ file, avatarUrl, format, exportfilename }) {
        const body = {
            file: ensureJsonl(file, 'file'),
            avatar_url: avatarUrl,
            format,
        };
        if (exportfilename !== undefined) {
            body.exportfilename = exportfilename;
        }
        return await this.client.post(`${CHATS_BASE}/export`, body);
    }

    /**
     * Import a chat file into a character's chat directory. The server picks
     * the stored file name itself ('<characterName> - <timestamp>
     * imported.jsonl').
     * Endpoint: POST /api/chats/import (multipart, file field 'avatar',
     * extra fields file_type, avatar_url, character_name, user_name).
     *
     * @param {Buffer|Uint8Array} buffer chat file bytes
     * @param {object} params
     * @param {string} params.avatarUrl character avatar file name
     * @param {'json'|'jsonl'} params.fileType 'jsonl' imports a native ST
     * chat log; 'json' imports a foreign format detected from the payload
     * (Kobold Lite, CAI Tools, Ooba data_visible, Agnai messages, RisuAI)
     * @param {string} [params.characterName] name to attribute imported
     * character messages to; '' makes the server default to 'Character'
     * (the field is always sent - the server would throw on undefined)
     * @param {string} [params.userName] name for imported user messages;
     * '' makes the server default to 'User'
     * @returns {Promise<{res: true, fileNames: string[]}|{error: true}>}
     * fileNames are the created chat files WITH the '.jsonl' extension;
     * {error: true} (HTTP 200) for malformed or unrecognized payloads
     * @throws {import('../core/client.js').StApiError} 400 when avatar_url
     * contains a forbidden character or no file was sent
     */
    async import(buffer, { avatarUrl, fileType, characterName = '', userName = '' }) {
        return await this.client.postFormJson(
            `${CHATS_BASE}/import`,
            {
                file_type: fileType,
                avatar_url: avatarUrl,
                character_name: characterName,
                user_name: userName,
            },
            { fieldName: 'avatar', fileName: `chat.${fileType}`, mimeType: 'application/octet-stream', data: buffer },
        );
    }
}
