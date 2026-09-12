/**
 * Characters API wrapper for the SillyTavern server (ST 1.18.0).
 *
 * All endpoints are POST under /api/characters/*. Field names and response
 * shapes were verified against the server source
 * (src/endpoints/characters.js) AND a live server.
 *
 * Transport notes (verified live):
 * - POST /api/characters/create is multipart-capable but also accepts an
 *   application/json body (the global bodyParser.json handles it, and the
 *   frontend /char-create slash command uses JSON too). This wrapper always
 *   sends JSON, because it is the only transport that preserves array values
 *   (alternate_greetings, tags) and numeric values (talkativeness,
 *   depth_prompt_depth) exactly. With multipart the client would have to
 *   repeat a field per array element (the browser frontend does
 *   formData.append('alternate_greetings', value) in a loop); a single
 *   JSON-stringified field is stored as a one-element array containing the
 *   raw JSON string, corrupting the data.
 * - create answers with PLAIN TEXT: the avatar file name, e.g. "Foo.png".
 * - edit / edit-attribute / edit-avatar / delete / merge-attributes (single
 *   mode) answer with plain text 'OK' (Express sendStatus(200) body).
 * - On ST 1.18.0, cards read back via get()/all()/export() report
 *   spec 'chara_card_v3' / spec_version '3.0' even though they are created
 *   from v2-shaped form data: the PNG writer emits both a 'chara' (v2) and a
 *   'ccv3' chunk and the reader prefers ccv3. The payload structure is still
 *   the classic v2 shape: top-level v1 mirrors (name, description, ...) plus
 *   the nested data.* v2 object.
 * - The server-side validateFileName middleware rejects any body field
 *   validated for file names (avatar_url, file_name, avatar) containing
 *   '/' (and '\' on Windows) with HTTP 400.
 */
const CHARACTERS_BASE = '/api/characters';

/**
 * Sentinel value understood by POST /api/characters/merge-attributes: any key
 * whose merge value equals this string is DELETED from the character card
 * instead of being set.
 * @type {string}
 */
export const UNSET_SENTINEL = '__@@UNSET@@__';

/**
 * High-level wrapper around the SillyTavern character endpoints.
 */
export class CharactersApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * List every character card.
     * Endpoint: POST /api/characters/all (empty body).
     * @returns {Promise<object[]>} array of characters; each entry carries the
     * v1 mirrors (name, description, avatar, chat, fav, tags, talkativeness),
     * the nested v2 `data` object, plus server-computed stats (date_added,
     * create_date, chat_size, date_last_chat, data_size, json_data).
     */
    async all() {
        return await this.client.post(`${CHARACTERS_BASE}/all`, {});
    }

    /**
     * Read a single character card.
     * Endpoint: POST /api/characters/get { avatar_url }.
     * @param {string} avatarUrl avatar file name, e.g. 'Foo.png'
     * @returns {Promise<object>} full character card (v1 mirrors + data.* v2
     * object + json_data/chat/create_date/stats)
     * @throws {StApiError} 404 when the avatar does not exist; 400 when
     * avatar_url contains a forbidden character ('/' or '\')
     */
    async get(avatarUrl) {
        return await this.client.post(`${CHARACTERS_BASE}/get`, { avatar_url: avatarUrl });
    }

    /**
     * Create a new character card. Uses the default avatar image when no
     * avatar upload is involved (avatar images can be attached later via
     * {@link CharactersApi#editAvatar}).
     * Endpoint: POST /api/characters/create (JSON body; see transport notes
     * at the top of this file for why JSON is used instead of multipart).
     *
     * @param {object} card character card fields
     * @param {string} card.ch_name REQUIRED display name
     * @param {string} [card.description] character description
     * @param {string} [card.personality] personality summary
     * @param {string} [card.scenario] scenario text
     * @param {string} [card.first_mes] first message / greeting
     * @param {string} [card.mes_example] example messages
     * @param {string} [card.creator_notes] creator notes (v1 mirror: creatorcomment)
     * @param {string|number} [card.talkativeness] 0..1, defaults to 0.5 (stored as-is; send a number to keep it numeric)
     * @param {string|boolean} [card.fav] 'true'/'false' string per the server
     * contract (server compares `fav == 'true'`); a boolean true/false is
     * accepted as a convenience and stringified here
     * @param {string[]|string} [card.tags] array (or comma-separated string) of tags
     * @param {string} [card.creator] creator name
     * @param {string} [card.character_version] version string
     * @param {string} [card.system_prompt] custom system prompt
     * @param {string} [card.post_history_instructions] jailbreak / post-history instructions
     * @param {string[]} [card.alternate_greetings] alternate greeting messages
     * @param {string} [card.world] name of a linked world info (lorebook) file
     * @param {string} [card.depth_prompt_prompt] author's note / depth prompt text
     * @param {string|number} [card.depth_prompt_depth] depth, defaults to 4 (stored as a number)
     * @param {string} [card.depth_prompt_role] 'system' (default), 'user' or 'assistant'
     * @param {string} [card.extensions] JSON string deep-merged into data.extensions
     * @param {string} [card.file_name] explicit internal file name (without
     * .png); defaults to a unique name derived from ch_name. Rejected with 400
     * if it contains '/' or '\'.
     * @returns {Promise<string>} avatar file name as PLAIN TEXT, e.g. 'Foo.png'
     * @throws {StApiError} 400 on a forbidden file_name
     */
    async create(card) {
        const body = { ...card };
        if (typeof body.fav === 'boolean') {
            body.fav = String(body.fav);
        }
        const text = await this.client.postRaw(`${CHARACTERS_BASE}/create`, body);
        return text.trim();
    }

    /**
     * Edit (overwrite) a character card. Fields not present in `card` fall
     * back to the server defaults (empty strings / 0.5 talkativeness etc.),
     * so pass the complete card when editing.
     * Endpoint: POST /api/characters/edit (JSON body; same field set as
     * {@link CharactersApi#create} plus avatar_url).
     *
     * @param {object} card card fields including:
     * @param {string} card.avatar_url REQUIRED avatar file name, e.g. 'Foo.png'
     * @param {string} card.ch_name REQUIRED display name (400 when missing/empty)
     * @param {string} [card.chat] current chat file name to preserve
     * @param {string} [card.create_date] original creation date to preserve
     * @param {...any} [card.rest] every field accepted by create()
     * @returns {Promise<string>} plain text 'OK'
     * @throws {StApiError} 400 when ch_name is missing/empty or avatar_url is forbidden
     */
    async edit(card) {
        const body = { ...card };
        if (typeof body.fav === 'boolean') {
            body.fav = String(body.fav);
        }
        return (await this.client.postRaw(`${CHARACTERS_BASE}/edit`, body)).trim();
    }

    /**
     * Edit a single attribute of an existing card. Writes the value to BOTH
     * the top-level (v1) key and the data.* (v2) key, so extension-only
     * fields (e.g. talkativeness lives at data.extensions.talkativeness) do
     * not survive a re-read - use {@link CharactersApi#mergeAttributes} for
     * those.
     * Endpoint: POST /api/characters/edit-attribute
     * { avatar_url, ch_name, field, value }.
     *
     * @param {string} avatarUrl avatar file name
     * @param {string} chName current display name (400 when empty)
     * @param {string} field top-level/data field name, e.g. 'description'
     * ('json_data' is rejected with 400; unknown fields are rejected with 400)
     * @param {any} value new value (strings, numbers, arrays, objects)
     * @returns {Promise<string>} plain text 'OK'
     * @throws {StApiError} 400 for empty ch_name, unknown or forbidden fields
     */
    async editAttribute(avatarUrl, chName, field, value) {
        return (await this.client.postRaw(`${CHARACTERS_BASE}/edit-attribute`, {
            avatar_url: avatarUrl,
            ch_name: chName,
            field,
            value,
        })).trim();
    }

    /**
     * Replace the character's avatar image while keeping the card data.
     * Endpoint: POST /api/characters/edit-avatar (multipart, file field
     * 'avatar', extra field avatar_url).
     *
     * @param {string} avatarUrl avatar file name of the character to update
     * @param {Buffer|Uint8Array} pngBuffer new image bytes (PNG or any
     * Jimp-readable image; the server re-encodes to PNG)
     * @returns {Promise<string>} plain text 'OK'
     * @throws {StApiError} 400 when avatar_url is forbidden
     */
    async editAvatar(avatarUrl, pngBuffer) {
        const text = await this.client.postForm(
            `${CHARACTERS_BASE}/edit-avatar`,
            { avatar_url: avatarUrl },
            { fieldName: 'avatar', fileName: avatarUrl, mimeType: 'image/png', data: pngBuffer },
        );
        return text.trim();
    }

    /**
     * Merge a patch into one or many character cards. The server deep-merges
     * the patch, validates the result against the TavernCard spec and writes
     * it back. Any patch value equal to {@link UNSET_SENTINEL} deletes that
     * key from the card. 'json_data' keys are always dropped from the patch.
     * Endpoint: POST /api/characters/merge-attributes.
     *
     * **Single mode** - `avatarUrlOrList` is a string: the patch object is
     * merged into the card root. Returns plain text 'OK'.
     *
     * **Bulk mode** - `avatarUrlOrList` is an array: the patch is sent under
     * `data` and applied to every listed avatar (an EMPTY array targets all
     * characters on the server). Returns {updated, skipped, failed}.
     *
     * @param {string|string[]} avatarUrlOrList single avatar file name, or a
     * list of avatar file names ([] = all characters; bulk mode only)
     * @param {object} [patch] merge payload; keys are card paths (e.g.
     * { creator: 'x' } or { data: { personality: 'y' } }). Use
     * UNSET_SENTINEL as a value to delete a key. In bulk mode the patch must
     * be a plain object; omitting it makes the server answer 400 ('No valid
     * update data provided.'). An empty object {} is accepted as a no-op.
     * @param {object} [options] bulk-mode options
     * @param {{path: string}} [options.filter] only update characters where
     * this card path resolves to a defined value; others are reported as
     * 'skipped'
     * @returns {Promise<string|{updated: string[], skipped: string[], failed: string[]}>}
     * 'OK' in single mode, the report object in bulk mode
     * @throws {StApiError} 500 in single mode when the avatar file does not
     * exist (server-side ENOENT, NOT 404); 400 in bulk mode for non-.png
     * avatar entries or a missing/non-object patch; 400 in single mode when
     * the merged card fails TavernCard validation
     */
    async mergeAttributes(avatarUrlOrList, patch, options = {}) {
        if (Array.isArray(avatarUrlOrList)) {
            const body = { avatars: avatarUrlOrList };
            if (patch !== undefined) {
                body.data = patch;
            }
            if (options.filter) {
                body.filter = options.filter;
            }
            return await this.client.post(`${CHARACTERS_BASE}/merge-attributes`, body);
        }
        const text = await this.client.postRaw(`${CHARACTERS_BASE}/merge-attributes`, {
            avatar: avatarUrlOrList,
            ...patch,
        });
        return text.trim();
    }

    /**
     * Rename a character (display name + avatar file name). The card data and
     * the chat directory are moved along.
     * Endpoint: POST /api/characters/rename { avatar_url, new_name }.
     *
     * @param {string} avatarUrl current avatar file name
     * @param {string} newName new display name (sanitized server-side; 400 when empty)
     * @returns {Promise<{avatar: string}>} the NEW avatar file name
     * @throws {StApiError} 400 when new_name is missing or avatar_url is forbidden
     */
    async rename(avatarUrl, newName) {
        return await this.client.post(`${CHARACTERS_BASE}/rename`, {
            avatar_url: avatarUrl,
            new_name: newName,
        });
    }

    /**
     * Duplicate a character card file (copies the PNG; chats are NOT copied).
     * The copy gets an incremented numeric suffix on its file name.
     * Endpoint: POST /api/characters/duplicate { avatar_url }.
     *
     * @param {string} avatarUrl avatar file name to copy
     * @returns {Promise<{path: string}>} file name of the created copy
     * @throws {StApiError} 404 when the source avatar does not exist
     */
    async duplicate(avatarUrl) {
        return await this.client.post(`${CHARACTERS_BASE}/duplicate`, { avatar_url: avatarUrl });
    }

    /**
     * Delete a character card.
     * Endpoint: POST /api/characters/delete { avatar_url, delete_chats }.
     *
     * @param {string} avatarUrl avatar file name to delete
     * @param {object} [options]
     * @param {boolean} [options.deleteChats=false] also recursively delete the
     * character's chat directory
     * @returns {Promise<string>} plain text 'OK'
     * @throws {StApiError} 400 when the avatar does not exist or avatar_url is
     * forbidden; 403 on a malicious file name
     */
    async delete(avatarUrl, { deleteChats = false } = {}) {
        const text = await this.client.postRaw(`${CHARACTERS_BASE}/delete`, {
            avatar_url: avatarUrl,
            delete_chats: deleteChats,
        });
        return text.trim();
    }

    /**
     * List the chat files stored for a character.
     * Endpoint: POST /api/characters/chats { avatar_url, simple?, metadata? }.
     *
     * @param {string} avatarUrl avatar file name whose chats to list
     * @param {object} [options]
     * @param {boolean} [options.simple=false] return only {file_name, file_id}
     * per chat instead of full info objects
     * @param {boolean} [options.metadata=false] include each chat's
     * chat_metadata in the result (ignored in simple mode)
     * @returns {Promise<object[]|{error: true}>} full mode: array of
     * {file_id, file_name, file_size, chat_items, mes, last_mes, match,
     * [chat_metadata]}; simple mode: array of {file_name, file_id}.
     * NOTE: when the character has no chat directory the server answers
     * 200 {error: true} (an object, not an array).
     * @throws {StApiError} 400 when avatar_url is forbidden
     */
    async chats(avatarUrl, { simple = false, metadata = false } = {}) {
        return await this.client.post(`${CHARACTERS_BASE}/chats`, {
            avatar_url: avatarUrl,
            simple,
            metadata,
        });
    }

    /**
     * Export a character card.
     * Endpoint: POST /api/characters/export { avatar_url, format }.
     * Private fields are stripped from the export (fav forced to false,
     * chat and json_data removed).
     *
     * @param {string} avatarUrl avatar file name
     * @param {'json'|'png'} format 'json' returns the card object; 'png'
     * returns the card image bytes (PNG with embedded card data)
     * @returns {Promise<object|Buffer>} card object for 'json', PNG buffer
     * for 'png'
     * @throws {StApiError} 404 when the avatar does not exist; 400 for any
     * other format value
     */
    async export(avatarUrl, format) {
        if (format === 'png') {
            return await this.client.postBinary(`${CHARACTERS_BASE}/export`, { avatar_url: avatarUrl, format });
        }
        return await this.client.post(`${CHARACTERS_BASE}/export`, { avatar_url: avatarUrl, format });
    }

    /**
     * Import a character card from file bytes.
     * Endpoint: POST /api/characters/import (multipart, file field 'avatar',
     * extra fields file_type and optionally preserved_name).
     * Supported file types: 'json', 'png', 'yaml', 'yml', 'charx', 'byaf'.
     *
     * @param {Buffer|Uint8Array} buffer card file bytes
     * @param {string} fileType one of 'json'|'png'|'yaml'|'yml'|'charx'|'byaf'
     * @param {object} [options]
     * @param {string} [options.preservedName] existing avatar file name to
     * OVERWRITE instead of creating a new unique file (with or without .png)
     * @returns {Promise<{file_name: string}|{error: true}>} on success the
     * stored internal file name WITHOUT the .png extension (ST quirk -
     * append '.png' yourself to build the avatar_url); {error: true} with
     * HTTP 200 when the format is unsupported or parsing failed
     * @throws {StApiError} 400 when no file was sent
     */
    async importCard(buffer, fileType, { preservedName } = {}) {
        const fields = { file_type: fileType };
        if (preservedName) {
            fields.preserved_name = preservedName;
        }
        return await this.client.postFormJson(
            `${CHARACTERS_BASE}/import`,
            fields,
            { fieldName: 'avatar', fileName: `import.${fileType}`, mimeType: 'application/octet-stream', data: buffer },
        );
    }
}
