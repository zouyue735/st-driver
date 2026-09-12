/**
 * Character sprites (expression images) API wrapper for SillyTavern (ST 1.18.0).
 *
 * Sprites are plain image files stored in the character's own folder:
 * characters/<name>/<spriteName>.<ext>. No character card is required —
 * /upload and /upload-zip create the folder on demand. A name containing a
 * '/' addresses a subfolder (characters/<char>/<subfolder>).
 *
 * Live-verified quirks (1.18.0):
 * - GET /api/sprites/get?name= answers with a JSON ARRAY [{label, path}]
 *   (the task brief guessed binary-or-404; it is neither). Unknown or empty
 *   character folders simply yield []. Errors inside the handler are
 *   swallowed, so a broken folder also yields [] with HTTP 200.
 * - The label reported by /get is the LOWERCASED file name, truncated at the
 *   first '-' or '.' (joy-1.png and joy.expressive.png both report 'joy').
 *   The path carries a ?t=<14-digit mtime> cache-buster.
 * - /upload and /upload-zip answer JSON ({ok: true} / {ok: true, count});
 *   /delete answers plain text 'OK' (sendStatus(200)).
 * - /delete of a nonexistent sprite inside an EXISTING folder answers 200
 *   (the delete loop just matches nothing). An unknown character folder
 *   answers 404. Missing both label and spriteName answers 400.
 * - /upload with a missing `name` field would create a literal
 *   'characters/undefined' folder (String(undefined) is truthy) — send a real
 *   name.
 * - Deleting every sprite leaves the empty character directory behind; there
 *   is no HTTP endpoint to remove it.
 * - /upload-zip extracts with yauzl: only image/* MIME entries are used
 *   (count excludes e.g. .txt), __MACOSX entries are skipped, and entries
 *   whose base name matches an existing sprite REPLACE it. A plain
 *   store-method (uncompressed) ZIP is accepted.
 */

const SPRITES_BASE = '/api/sprites';

/**
 * Require a non-empty name/label argument.
 * @param {unknown} value
 * @param {string} label parameter name for the error message
 * @returns {string}
 */
function requireName(value, label) {
    if (value === undefined || value === null || !String(value).trim().length) {
        throw new TypeError(`SpritesApi: '${label}' must be a non-empty string (got ${value})`);
    }
    return String(value);
}

/**
 * High-level wrapper around the SillyTavern sprite endpoints.
 */
export class SpritesApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * List every sprite image of a character (or character subfolder).
     * Endpoint: GET /api/sprites/get?name=<name> — answers JSON despite being
     * a GET; this wrapper parses it.
     *
     * @param {string} name character name (or 'char/subfolder')
     * @returns {Promise<{label: string, path: string}[]>} label is the
     * lowercased file name truncated at the first '-' or '.'; path is
     * '/characters/<name>/<file>?t=<mtime>' ready for an <img src>
     * @throws {TypeError} client-side when name is missing or empty
     * (the raw server would answer '[]' for the literal name 'undefined')
     */
    async get(name) {
        const text = await this.client.getRaw(`${SPRITES_BASE}/get?name=${encodeURIComponent(requireName(name, 'name'))}`);
        return JSON.parse(text);
    }

    /**
     * Upload a single sprite image (multipart, file field 'avatar'). The
     * character's sprites folder is created when missing; an existing sprite
     * with the same name is replaced.
     * Endpoint: POST /api/sprites/upload { name, label, spriteName? } + file.
     *
     * @param {object} params
     * @param {string} params.name character name (folder is created on demand)
     * @param {string} params.label sprite label; also the stored file name
     * when spriteName is absent (the uploaded file's extension is kept)
     * @param {string} [params.spriteName] store the file under this name
     * instead of the label (e.g. 'joy-1' or 'joy.expressive')
     * @param {Buffer|Uint8Array} buffer image bytes
     * @param {object} [options]
     * @param {string} [options.fileName='<label>.png'] multipart file name;
     * only its EXTENSION is used by the server
     * @returns {Promise<{ok: true}>}
     * @throws {TypeError} client-side when name/label is missing
     * @throws {import('../core/client.js').StApiError} 400 when no file was
     * sent or label/name is missing server-side; 500 on a write failure
     */
    async upload({ name, label, spriteName }, buffer, { fileName } = {}) {
        requireName(name, 'name');
        requireName(label, 'label');
        const fields = { name, label };
        if (spriteName !== undefined) {
            fields.spriteName = spriteName;
        }
        return await this.client.postFormJson(
            `${SPRITES_BASE}/upload`,
            fields,
            { fieldName: 'avatar', fileName: fileName ?? `${label}.png`, mimeType: 'application/octet-stream', data: buffer },
        );
    }

    /**
     * Upload a ZIP sprite pack (multipart, file field 'avatar'). Every
     * image/* entry is extracted into the character's sprites folder,
     * replacing same-name sprites. A plain store-method ZIP works; the server
     * uses yauzl, so deflate-compressed packs work too.
     * Endpoint: POST /api/sprites/upload-zip { name } + file.
     *
     * @param {string} name character name (folder is created on demand)
     * @param {Buffer|Uint8Array} zipBuffer ZIP file bytes
     * @param {object} [options]
     * @param {string} [options.fileName='sprites.zip'] multipart file name
     * @returns {Promise<{ok: true, count: number}>} count is the number of
     * IMAGE entries written (non-image entries are ignored)
     * @throws {TypeError} client-side when name is missing
     * @throws {import('../core/client.js').StApiError} 400 when no file was
     * sent or name is missing server-side; 500 when the ZIP cannot be read
     */
    async uploadZip(name, zipBuffer, { fileName = 'sprites.zip' } = {}) {
        requireName(name, 'name');
        return await this.client.postFormJson(
            `${SPRITES_BASE}/upload-zip`,
            { name },
            { fieldName: 'avatar', fileName, mimeType: 'application/zip', data: zipBuffer },
        );
    }

    /**
     * Delete a sprite by its file name (without extension). Pass either
     * `label` or `spriteName`; when both are given the server prefers
     * spriteName (spriteName || label).
     * Endpoint: POST /api/sprites/delete { name, label?, spriteName? }.
     *
     * @param {object} params
     * @param {string} params.name character name
     * @param {string} [params.label] sprite label (file base name)
     * @param {string} [params.spriteName] exact file base name to delete
     * @returns {Promise<string>} plain text 'OK' (sendStatus(200)); deleting
     * a sprite that does not exist inside an existing folder ALSO answers OK
     * @throws {TypeError} client-side when name is missing or neither label
     * nor spriteName was given
     * @throws {import('../core/client.js').StApiError} 400 when the character
     * folder exists but neither label nor spriteName was sent; 404 when the
     * character folder does not exist; 500 on a filesystem error
     */
    async delete({ name, label, spriteName }) {
        requireName(name, 'name');
        if (spriteName === undefined && label === undefined) {
            throw new TypeError('SpritesApi: delete() requires label or spriteName');
        }
        const body = { name };
        if (label !== undefined) {
            body.label = label;
        }
        if (spriteName !== undefined) {
            body.spriteName = spriteName;
        }
        return await this.client.postRaw(`${SPRITES_BASE}/delete`, body);
    }
}
