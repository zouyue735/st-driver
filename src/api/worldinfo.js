/**
 * World Info (lorebook) API driver for SillyTavern 1.18.0.
 *
 * Endpoints (verified against src/endpoints/worldinfo.js):
 *   POST /api/worldinfo/list   -> [{ file_id, name, extensions }]
 *   POST /api/worldinfo/get    -> { entries: { uid -> entry } }
 *   POST /api/worldinfo/edit   -> { ok: true }  (body: { name, data })
 *   POST /api/worldinfo/delete -> 200 (empty body)
 *   POST /api/worldinfo/import -> { name }      (multipart, file field `avatar`)
 *
 * Observed quirks:
 * - get() of a NON-EXISTENT world returns the dummy { entries: {} } with
 *   status 200 (readWorldInfoFile allowDummy=true), not an error.
 * - edit() writes <name>.json unconditionally, so editing a fresh name
 *   CREATES the world (no import needed). `data` must contain `entries`.
 * - import() requires an uploaded file even when the convertedData body
 *   field carries the JSON; the stored world name comes from the uploaded
 *   file's original name. JSON without an `entries` key -> 400.
 * - delete() of a non-existent world -> 500 (the handler throws).
 * - edit()/get() perform NO normalization: entry fields round-trip exactly.
 */

/** World Info entry position enum (wi_position in ST). */
export const EntryPosition = Object.freeze({
    BEFORE_CHAR: 0,
    AFTER_CHAR: 1,
    AN_TOP: 2,
    AN_BOTTOM: 3,
    AT_DEPTH: 4,
    EM_TOP: 5,
    EM_BOTTOM: 6,
    OUTLET: 7,
});

/** Selective logic enum applied to keysecondary (wi_logic in ST). */
export const SelectiveLogic = Object.freeze({
    AND: 0,
    NOT: 1,
    NOT_ALL: 2,
    AND_NOT: 3,
});

/** Message role override enum (wi_role in ST). */
export const EntryRole = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/**
 * @typedef {object} WorldInfoEntry
 * ST-internal entry format. All keys are stored verbatim in the world file.
 * @property {string} uid unique id (matches the entries object key)
 * @property {string[]} key primary activation keys
 * @property {string[]} keysecondary secondary activation keys
 * @property {string} comment entry title / comment
 * @property {string} content lore text
 * @property {boolean} constant always-active (pinned)
 * @property {boolean} vectorized embedding cache flag
 * @property {boolean} selective use secondary keys
 * @property {number} selectiveLogic 0-3, see SelectiveLogic
 * @property {string} addMemo author's note / memo
 * @property {number} order sort order
 * @property {number} position 0-7, see EntryPosition
 * @property {boolean} disable entry is disabled
 * @property {boolean} ignoreBudget exempt from the token budget
 * @property {boolean} excludeRecursion not activated by recursion
 * @property {boolean} preventRecursion does not trigger further recursion
 * @property {boolean} delayUntilRecursion only fires on recursive scans
 * @property {boolean} matchPersonaDescription
 * @property {boolean} matchCharacterDescription
 * @property {boolean} matchCharacterPersonality
 * @property {boolean} matchCharacterDepthPrompt
 * @property {boolean} matchScenario
 * @property {boolean} matchCreatorNotes
 * @property {number} probability activation chance (percent)
 * @property {boolean} useProbability apply probability
 * @property {number} depth depth for the AT_DEPTH position
 * @property {string} outletName custom outlet for the OUTLET position
 * @property {string} group entry group name
 * @property {boolean} groupOverride override character group scoring
 * @property {number} groupWeight group scoring weight
 * @property {number} scanDepth per-entry scan depth
 * @property {boolean} caseSensitive
 * @property {boolean} matchWholeWords
 * @property {boolean} useGroupScoring
 * @property {string} automationId automation / sticky id
 * @property {number} role 0-2, see EntryRole
 * @property {number} sticky sticky duration (messages)
 * @property {number} cooldown cooldown duration (messages)
 * @property {number} delay delay duration (messages)
 * @property {string[]} characterFilterNames only for these characters
 * @property {string[]} characterFilterTags only for these tags
 * @property {boolean} characterFilterExclude filters are exclusive
 * @property {Array<string[]>} triggers trigger groups (string arrays)
 */

/**
 * @typedef {object} WorldInfo
 * @property {object.<string, WorldInfoEntry>} entries uid -> entry map
 * @property {string} [name] display name (falls back to the file id in list())
 * @property {object} [extensions]
 */

export class WorldInfoApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/worldinfo/list - list every world book file.
     * @returns {Promise<Array<{file_id: string, name: string, extensions: object}>>}
     * file_id is the file name without extension; name is the contents' name
     * field or file_id when absent
     */
    async list() {
        return await this.client.post('/api/worldinfo/list', {});
    }

    /**
     * POST /api/worldinfo/get - read a world book.
     * @param {string} name world file name (without .json)
     * @returns {Promise<WorldInfo>} the world object; { entries: {} } when the
     * world does not exist (observed: 200 + dummy object, not an error)
     */
    async get(name) {
        return await this.client.post('/api/worldinfo/get', { name });
    }

    /**
     * POST /api/worldinfo/edit - write a whole world book (full overwrite).
     * Editing a non-existent name CREATES the world book, so this is also
     * the simplest way to make a new one (no import required).
     * @param {string} name world file name (without .json)
     * @param {WorldInfo} data complete world object; must contain `entries`
     * @returns {Promise<{ok: boolean}>}
     * @throws {import('../core/client.js').StApiError} 400 when name or
     * data.entries is missing
     */
    async edit(name, data) {
        return await this.client.post('/api/worldinfo/edit', { name, data });
    }

    /**
     * POST /api/worldinfo/delete - delete a world book file.
     * @param {string} name world file name (without .json)
     * @returns {Promise<null>} the server answers 200 with an empty body
     * @throws {import('../core/client.js').StApiError} 400 without name,
     * 500 when the file does not exist (observed: handler throws)
     */
    async delete(name) {
        return await this.client.post('/api/worldinfo/delete', { name });
    }

    /**
     * POST /api/worldinfo/import - import a world book as a new file.
     * Multipart: the world JSON is uploaded as a file (field name `avatar`;
     * the stored name derives from its original file name). Alternatively
     * (or additionally) pass `convertedData` as a body field - when present
     * the server stores THAT string instead of the file bytes.
     * @param {object|Buffer|Uint8Array|string} data world book JSON containing
     * an `entries` key (object is serialized; string/bytes sent as-is)
     * @param {object} options
     * @param {string} options.name new world name (used as the uploaded file name)
     * @param {object|string} [options.convertedData] override contents sent as a
     * body field instead of the file bytes
     * @returns {Promise<{name: string}>} the stored world name
     * @throws {import('../core/client.js').StApiError} 400 when the JSON has no
     * `entries` key or no name is given
     */
    async import(data, { name, convertedData } = {}) {
        if (!name) {
            throw new Error('worldinfo import requires a name (used as the uploaded file name)');
        }
        let bytes;
        if (Buffer.isBuffer(data)) {
            bytes = data;
        } else if (data instanceof Uint8Array) {
            bytes = Buffer.from(data);
        } else if (typeof data === 'string') {
            bytes = Buffer.from(data, 'utf8');
        } else {
            bytes = Buffer.from(JSON.stringify(data), 'utf8');
        }
        const fields = {};
        if (convertedData !== undefined) {
            fields.convertedData = typeof convertedData === 'string' ? convertedData : JSON.stringify(convertedData);
        }
        return await this.client.postFormJson('/api/worldinfo/import', fields, {
            fieldName: 'avatar',
            fileName: `${name}.json`,
            mimeType: 'application/json',
            data: bytes,
        });
    }
}
