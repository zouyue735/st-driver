/**
 * Media APIs wrapper for the SillyTavern server (ST 1.18.0):
 *
 * - FilesApi          -> /api/files            (user/files uploads, chat attachments)
 * - ImageMetadataApi  -> /api/image-metadata   (virtual folders + image metadata index)
 * - ImagesApi         -> /api/images           (user/images uploads, listing)
 * - AssetsApi         -> /api/assets           (asset categories, read-only here)
 * - MediaApi          -> facade bundling all four (matches src/index.js registry)
 *
 * Field names and response shapes were verified against the server sources
 * (src/endpoints/files.js, image-metadata.js, images.js, assets.js) AND a
 * live server.
 *
 * Live-verified quirks (1.18.0):
 * - files/sanitize-filename with a MISSING fileName field answers
 *   {fileName: 'undefined'} (String(undefined) is truthy); an EMPTY string
 *   answers 400.
 * - files/upload validates the name itself: only [a-zA-Z0-9_\-.], no unsafe
 *   extension (.exe, .php, ...), must not start with '.', else 400.
 * - files/verify silently SKIPS urls outside user/files — they do not appear
 *   in the result map at all.
 * - images/upload expects PURE base64 in `image`; a data URI is NOT stripped
 *   and corrupts the stored file. `format` must be one of the MEDIA_EXTENSIONS
 *   without the dot ('png', 'jpg', ...). fileName keeps only its base — the
 *   extension is always replaced by `format`; omitting fileName yields
 *   '<Date.now()>.<format>'. characterName places the file into a subfolder.
 * - images/list CREATES the folder when it does not exist, answering [].
 *   Defaults: sortField 'date', sortOrder 'asc', type 1 (images only).
 * - image-metadata root POST: single {path} outside the user data dir throws
 *   inside the handler -> 500; batch {paths} with the same path becomes an
 *   {error} entry in an HTTP 200 map.
 * - folders/assign only accepts 'backgrounds/...' relative paths — anything
 *   else answers 500 (not 400). Missing files are silently skipped (200).
 * - folders/unassign does NOT check folder existence (always {ok: true}).
 * - folders/set-thumbnails silently skips unknown folder ids.
 * - all({prefix}) omits the `folders` key entirely ({version, images} only).
 * - assets/get excludes the 'temp' category; 'vrm' is shaped
 *   {model: [], animation: []} while every other category is a flat array.
 */

const FILES_BASE = '/api/files';
const IMAGE_METADATA_BASE = '/api/image-metadata';
const IMAGES_BASE = '/api/images';
const ASSETS_BASE = '/api/assets';

/**
 * High-level wrapper around /api/files/* (the user/files upload area used by
 * chat attachments). Every path in responses is client-relative and starts
 * with '/user/files/'.
 */
export class FilesApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Sanitize a file name the same way the server would before storing it.
     * Endpoint: POST /api/files/sanitize-filename { fileName }.
     *
     * @param {object} params
     * @param {string} params.fileName raw file name
     * @returns {Promise<{fileName: string}>} the sanitized name (illegal
     * characters <>:"|?*\, control codes and slashes are STRIPPED, not
     * replaced)
     * @throws {import('../core/client.js').StApiError} 400 when fileName is an
     * empty string. QUIRK: when the field is MISSING entirely the server
     * answers {fileName: 'undefined'} with HTTP 200.
     */
    async sanitizeFilename({ fileName }) {
        return await this.client.post(`${FILES_BASE}/sanitize-filename`, { fileName });
    }

    /**
     * Upload a file (base64 JSON body, NOT multipart) into user/files.
     * Endpoint: POST /api/files/upload { name, data }.
     *
     * @param {object} params
     * @param {string} params.name stored file name; only [a-zA-Z0-9_\-.] is
     * allowed, it must not start with '.' and the extension must not be in
     * the server's unsafe list (.exe, .php, .dll, ...)
     * @param {string} params.data file content as a base64 string
     * @returns {Promise<{path: string}>} client-relative path, e.g.
     * '/user/files/myfile.txt'
     * @throws {import('../core/client.js').StApiError} 400 when name or data
     * is missing, or the name fails validation
     */
    async upload({ name, data }) {
        return await this.client.post(`${FILES_BASE}/upload`, { name, data });
    }

    /**
     * Delete a previously uploaded file.
     * Endpoint: POST /api/files/delete { path }.
     *
     * @param {object} params
     * @param {string} params.path client-relative path as returned by upload
     * (leading slash optional)
     * @returns {Promise<string>} plain text 'OK' (sendStatus(200))
     * @throws {import('../core/client.js').StApiError} 400 when path is
     * missing or resolves outside user/files; 404 when the file does not exist
     */
    async delete({ path }) {
        return await this.client.postRaw(`${FILES_BASE}/delete`, { path });
    }

    /**
     * Check which of the given urls exist inside user/files.
     * Endpoint: POST /api/files/verify { urls }.
     *
     * @param {object} params
     * @param {string[]} params.urls client-relative paths to check
     * @returns {Promise<Object<string, boolean>>} url -> exists map. QUIRK:
     * urls resolving outside user/files are silently SKIPPED (absent from the
     * map); an empty array answers {}.
     * @throws {import('../core/client.js').StApiError} 400 when urls is not
     * an array
     */
    async verify({ urls }) {
        return await this.client.post(`${FILES_BASE}/verify`, { urls });
    }
}

/**
 * Wrapper around /api/image-metadata/* — the central image metadata index
 * (hash, aspect ratio, dominant color, animation flag) and the virtual
 * background folders built on top of it.
 *
 * Relative paths used here are POSIX-style and relative to the user data
 * root, e.g. 'backgrounds/foo.png' or 'user/images/sub/bar.png' (no leading
 * slash).
 */
export class ImageMetadataApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Get (or generate) the metadata of a single image.
     * Endpoint: POST /api/image-metadata { path, type? }.
     *
     * @param {object} params
     * @param {string} params.path relative path, e.g. 'backgrounds/foo.png'
     * @param {'bg'|'avatar'|'persona'} [params.type] thumbnail type used to
     * compute thumbnailResolution when the entry is FIRST generated
     * (avatar/persona: 96*144 = 13824; omitting type yields 0). QUIRK: the
     * value is cached by file mtime — later calls with a different type keep
     * answering the cached one, and /api/backgrounds/upload pre-generates
     * every background entry with type 'bg' (14400).
     * @returns {Promise<{hash: string, aspectRatio: number, isAnimated: boolean, dominantColor: string, folderIds: string[], addedTimestamp: number, thumbnailResolution: number, mtime: number}>}
     * @throws {import('../core/client.js').StApiError} 404 when the file does
     * not exist or metadata generation fails; 500 when the path escapes the
     * user data directory (quirk: not 400)
     */
    async get({ path, type }) {
        const body = { path };
        if (type !== undefined) {
            body.type = type;
        }
        return await this.client.post(IMAGE_METADATA_BASE, body);
    }

    /**
     * Get (or generate) metadata for several images in one batch.
     * Endpoint: POST /api/image-metadata { paths, type? }.
     *
     * @param {object} params
     * @param {string[]} params.paths relative paths
     * @param {'bg'|'avatar'|'persona'} [params.type] see get()
     * @returns {Promise<Object<string, object>>} path -> metadata object, or
     * path -> {error} for paths outside the data dir / unreadable files
     * (HTTP stays 200 — the batch form is lenient where the single form 500s)
     */
    async getBatch({ paths, type }) {
        const body = { paths };
        if (type !== undefined) {
            body.type = type;
        }
        return await this.client.post(IMAGE_METADATA_BASE, body);
    }

    /**
     * Create a virtual folder (used by the background UI to group images).
     * Endpoint: POST /api/image-metadata/folders/create { name }.
     *
     * @param {object} params
     * @param {string} params.name folder name (trimmed server-side)
     * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
     * @throws {import('../core/client.js').StApiError} 400 when name is
     * missing or not a string
     */
    async createFolder({ name }) {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/create`, { name });
    }

    /**
     * List every virtual folder.
     * Endpoint: POST /api/image-metadata/folders/get {}.
     *
     * @returns {Promise<{id: string, name: string, thumbnailFile: string}[]>}
     */
    async listFolders() {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/get`, {});
    }

    /**
     * Update one virtual folder (rename and/or set its thumbnail).
     * Endpoint: POST /api/image-metadata/folders/update { id, name?, thumbnailFile? }.
     *
     * @param {object} params
     * @param {string} params.id folder id
     * @param {string} [params.name] new name
     * @param {string} [params.thumbnailFile] new thumbnail file name ('' clears)
     * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
     * @throws {import('../core/client.js').StApiError} 400 when id is
     * missing; 404 when the folder does not exist
     */
    async updateFolder({ id, name, thumbnailFile }) {
        const body = { id };
        if (name !== undefined) {
            body.name = name;
        }
        if (thumbnailFile !== undefined) {
            body.thumbnailFile = thumbnailFile;
        }
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/update`, body);
    }

    /**
     * Set thumbnails for multiple folders in one atomic write.
     * Endpoint: POST /api/image-metadata/folders/set-thumbnails { updates }.
     *
     * @param {object} params
     * @param {{id: string, thumbnailFile: string}[]} params.updates
     * @returns {Promise<{ok: true}>} QUIRK: unknown folder ids are silently
     * skipped, still answering {ok: true}
     * @throws {import('../core/client.js').StApiError} 400 when updates is
     * not an array of {id, thumbnailFile}
     */
    async setFolderThumbnails({ updates }) {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/set-thumbnails`, { updates });
    }

    /**
     * Assign images to a virtual folder.
     * Endpoint: POST /api/image-metadata/folders/assign { id, paths }.
     *
     * @param {object} params
     * @param {string} params.id folder id
     * @param {string[]} params.paths relative paths — ONLY 'backgrounds/...'
     * paths are accepted (anything else answers 500, quirk); paths without a
     * metadata entry get a stub; missing files are silently skipped
     * @returns {Promise<{ok: true}>}
     * @throws {import('../core/client.js').StApiError} 400 when id or paths
     * is missing; 404 when the folder does not exist; 500 when a path is not
     * under backgrounds/ or contains '..'
     */
    async assignImages({ id, paths }) {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/assign`, { id, paths });
    }

    /**
     * Remove images from a virtual folder.
     * Endpoint: POST /api/image-metadata/folders/unassign { id, paths }.
     *
     * @param {object} params
     * @param {string} params.id folder id
     * @param {string[]} params.paths relative paths
     * @returns {Promise<{ok: true}>} QUIRK: unlike assign, there is NO folder
     * existence check and no path restriction — unknown ids answer {ok: true}
     * @throws {import('../core/client.js').StApiError} 400 when id or paths
     * is missing
     */
    async unassignImages({ id, paths }) {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/unassign`, { id, paths });
    }

    /**
     * Delete a virtual folder; every image assigned to it is unassigned.
     * Endpoint: POST /api/image-metadata/folders/delete { id }.
     *
     * @param {object} params
     * @param {string} params.id folder id
     * @returns {Promise<{ok: true}>}
     * @throws {import('../core/client.js').StApiError} 400 when id is
     * missing; 404 when the folder does not exist
     */
    async deleteFolder({ id }) {
        return await this.client.post(`${IMAGE_METADATA_BASE}/folders/delete`, { id });
    }

    /**
     * Read the whole metadata index, optionally filtered by path prefix.
     * Endpoint: POST /api/image-metadata/all { prefix? }.
     *
     * @param {object} [params]
     * @param {string} [params.prefix] only return images whose relative path
     * starts with this string
     * @returns {Promise<{version: number, images: Object<string, object>, folders?: object[]}>}
     * QUIRK: with a prefix the response OMITS the folders key entirely
     */
    async all({ prefix } = {}) {
        const body = {};
        if (prefix !== undefined) {
            body.prefix = prefix;
        }
        return await this.client.post(`${IMAGE_METADATA_BASE}/all`, body);
    }

    /**
     * Remove index entries whose files no longer exist on disk.
     * Endpoint: POST /api/image-metadata/cleanup {}.
     *
     * @returns {Promise<{removed: string[], count: number}>}
     */
    async cleanup() {
        return await this.client.post(`${IMAGE_METADATA_BASE}/cleanup`, {});
    }
}

/**
 * Wrapper around /api/images/* — the user/images upload area (images sent
 * with chat messages, per-character subfolders).
 */
export class ImagesApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Upload an image as PURE base64 in a JSON body (not multipart, not a
     * data URI — a data URI corrupts the stored file).
     * Endpoint: POST /api/images/upload { image, format, filename?, ch_name? }.
     *
     * @param {object} params
     * @param {string} params.image image bytes as a base64 string (no
     * 'data:...' prefix)
     * @param {string} params.format extension WITHOUT the dot, one of the
     * server's MEDIA_EXTENSIONS ('png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
     * 'mp4', ...)
     * @param {string} [params.fileName] stored base name; any extension it
     * carries is REPLACED by format. Omit it to get '<Date.now()>.<format>'
     * @param {string} [params.characterName] store the image in a
     * user/images/<characterName>/ subfolder (created on demand)
     * @returns {Promise<{path: string}>} client-relative path, e.g.
     * '/user/images/<name>.png' or '/user/images/<sub>/<name>.png'
     * @throws {import('../core/client.js').StApiError} 400 when image is
     * missing or format is invalid
     */
    async upload({ image, format, fileName, characterName }) {
        const body = { image, format };
        if (fileName !== undefined) {
            body.filename = fileName;
        }
        if (characterName !== undefined) {
            body.ch_name = characterName;
        }
        return await this.client.post(`${IMAGES_BASE}/upload`, body);
    }

    /**
     * List the media file names inside one user/images subfolder.
     * Endpoint: POST /api/images/list { folder, sortField?, sortOrder?, type? }.
     *
     * @param {string} folder subfolder name relative to user/images ('.'
     * lists the root)
     * @param {object} [options]
     * @param {'name'|'date'} [options.sortField='date'] sort by name or mtime
     * @param {'asc'|'desc'} [options.sortOrder='asc'] sort direction
     * @param {number} [options.type=1] media bitmask: 1 images, 2 videos,
     * 4 audio (combinable, e.g. 3 = images+videos)
     * @returns {Promise<string[]>} file names (no paths). QUIRK: a folder
     * that does not exist is CREATED and answered as []
     * @throws {import('../core/client.js').StApiError} 400 when folder is
     * missing or empty
     */
    async list(folder, { sortField, sortOrder, type } = {}) {
        const body = { folder };
        if (sortField !== undefined) {
            body.sortField = sortField;
        }
        if (sortOrder !== undefined) {
            body.sortOrder = sortOrder;
        }
        if (type !== undefined) {
            body.type = type;
        }
        return await this.client.post(`${IMAGES_BASE}/list`, body);
    }

    /**
     * List every subfolder of user/images.
     * Endpoint: POST /api/images/folders {}.
     *
     * @returns {Promise<string[]>} directory names
     * @throws {import('../core/client.js').StApiError} 500 when the directory
     * cannot be read
     */
    async folders() {
        return await this.client.post(`${IMAGES_BASE}/folders`, {});
    }

    /**
     * Delete an uploaded image.
     * Endpoint: POST /api/images/delete { path }.
     *
     * @param {object} params
     * @param {string} params.path client-relative path as returned by upload
     * @returns {Promise<string>} plain text 'OK' (sendStatus(200))
     * @throws {import('../core/client.js').StApiError} 400 when path is
     * missing or resolves outside user/images; 404 when the file does not
     * exist
     */
    async delete({ path }) {
        return await this.client.postRaw(`${IMAGES_BASE}/delete`, { path });
    }
}

/**
 * Read-only wrapper around /api/assets/get — lists the user's asset library
 * by category. Downloads/deletes go through the frontend UI and are out of
 * scope here.
 */
export class AssetsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * List every asset category and its files.
     * Endpoint: POST /api/assets/get {}.
     *
     * @returns {Promise<{bgm: string[], ambient: string[], blip: string[], live2d: string[], character: string[], vrm: {model: string[], animation: string[]}}>}
     * categories are relative paths like 'assets/bgm/<file>'; the 'temp'
     * category is excluded and 'vrm' is a nested {model, animation} object
     */
    async get() {
        return await this.client.post(`${ASSETS_BASE}/get`, {});
    }
}

/**
 * Facade bundling the four media APIs — the export expected by the
 * src/index.js module registry ('media' -> MediaApi).
 */
export class MediaApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        /** @type {FilesApi} */
        this.files = new FilesApi(client);
        /** @type {ImageMetadataApi} */
        this.metadata = new ImageMetadataApi(client);
        /** @type {ImagesApi} */
        this.images = new ImagesApi(client);
        /** @type {AssetsApi} */
        this.assets = new AssetsApi(client);
    }
}
