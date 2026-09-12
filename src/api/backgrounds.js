/**
 * Backgrounds API wrapper for the SillyTavern server (ST 1.18.0).
 *
 * Endpoints live under /api/backgrounds/*. Field names and response shapes
 * were verified against the server source (src/endpoints/backgrounds.js) AND
 * a live server.
 *
 * Live-verified quirks (1.18.0):
 * - /upload, /rename and /delete answer with PLAIN TEXT, not JSON:
 *   /upload returns the sanitized filename, the other two return the literal
 *   string 'ok'.
 * - /rename with a MISSING old_bg field answers 500 (not 400) — the handler
 *   crashes on sanitize(undefined). Same for /delete with a missing bg field.
 * - /delete guards `bg` with the validateFileName middleware: a '/' (or '\'
 *   on Windows, or NUL) inside bg is rejected with 400.
 * - /upload does NOT validate the multipart filename: 'bad/name.png' is
 *   silently stored as 'name.png' (sanitize-filename strips the slash).
 * - /rename and /delete answer 400 for a nonexistent source; /rename also
 *   answers 400 when the destination already exists.
 * - /all generates image metadata on demand (hash, dominant color, ...), so
 *   the first call after a server restart can be slow.
 */

const BACKGROUNDS_BASE = '/api/backgrounds';

/**
 * High-level wrapper around the SillyTavern background endpoints.
 */
export class BackgroundsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * List every background image together with the thumbnail config.
     * Endpoint: POST /api/backgrounds/all {}.
     *
     * @returns {Promise<{images: {filename: string, isAnimated: boolean}[], config: {width: number, height: number}}>}
     * config carries the configured bg thumbnail dimensions (default 160x90)
     * @throws {import('../core/client.js').StApiError} 500 on a server-side
     * directory/metadata failure
     */
    async all() {
        return await this.client.post(`${BACKGROUNDS_BASE}/all`, {});
    }

    /**
     * List the virtual image folders and the per-image folder assignments
     * (virtual folders are managed through the /api/image-metadata/folders/*
     * endpoints — see ImageMetadataApi).
     * Endpoint: POST /api/backgrounds/folders {}.
     *
     * @returns {Promise<{folders: {id: string, name: string, thumbnailFile: string}[], imageFolderMap: Object<string, string[]>}>}
     * imageFolderMap maps background filename -> array of folder ids
     * (only images with at least one assignment appear)
     * @throws {import('../core/client.js').StApiError} 500 when the metadata
     * index cannot be read
     */
    async folders() {
        return await this.client.post(`${BACKGROUNDS_BASE}/folders`, {});
    }

    /**
     * Upload a new background image (multipart, file field 'avatar').
     * Endpoint: POST /api/backgrounds/upload.
     *
     * @param {Buffer|Uint8Array} buffer image bytes
     * @param {string} fileName file name to store the image under; the server
     * runs it through sanitize-filename, so a '/' is STRIPPED silently (e.g.
     * 'bad/name.png' is stored as 'name.png') and the sanitized name is
     * returned
     * @returns {Promise<string>} plain text: the sanitized stored filename
     * @throws {import('../core/client.js').StApiError} 400 when no file was
     * sent; 500 when the file could not be written
     */
    async upload(buffer, fileName) {
        return await this.client.postForm(
            `${BACKGROUNDS_BASE}/upload`,
            {},
            { fieldName: 'avatar', fileName, mimeType: 'application/octet-stream', data: buffer },
        );
    }

    /**
     * Rename a background image (copy + delete; metadata and thumbnails are
     * updated accordingly).
     * Endpoint: POST /api/backgrounds/rename { old_bg, new_bg }.
     *
     * @param {object} params
     * @param {string} params.oldBg current file name
     * @param {string} params.newBg new file name (must not exist yet; it is
     * sanitized server-side)
     * @returns {Promise<string>} plain text 'ok'
     * @throws {import('../core/client.js').StApiError} 400 when old_bg does
     * not exist or new_bg already exists; 500 when old_bg is missing entirely
     * (ST quirk: the handler crashes on sanitize(undefined))
     */
    async rename({ oldBg, newBg }) {
        return await this.client.postRaw(`${BACKGROUNDS_BASE}/rename`, {
            old_bg: oldBg,
            new_bg: newBg,
        });
    }

    /**
     * Delete a background image (and its metadata entry).
     * Endpoint: POST /api/backgrounds/delete { bg }.
     *
     * @param {string} bg file name of the background to delete
     * @returns {Promise<string>} plain text 'ok'
     * @throws {import('../core/client.js').StApiError} 400 when the file does
     * not exist or bg contains '/', '\' or NUL (validateFileName middleware);
     * 403 when the sanitized name differs (malicious name); 500 when bg is
     * missing entirely (ST quirk)
     */
    async delete(bg) {
        return await this.client.postRaw(`${BACKGROUNDS_BASE}/delete`, { bg });
    }
}
