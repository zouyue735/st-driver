/**
 * Content Manager API wrapper (Data Bank remote-content import), ST 1.18.0.
 *
 * Both endpoints DOWNLOAD content from external whitelisted providers and
 * answer with the raw file bytes plus response headers:
 *   - Content-Type: the provider file type (e.g. image/png)
 *   - Content-Disposition: attachment; filename="<name>"
 *   - X-Custom-Content-Type: 'character' | 'lorebook'
 *
 * Supported hosts (verified in src/endpoints/content-manager.js): chub.ai /
 * characterhub.org, janitorai.com, pygmalion.chat, aicharactercards.com,
 * realm.risuai.net, perchance.org, plus generic hosts listed in the server
 * config key `whitelistImportDomains`. Anything else → 404.
 *
 * Error semantics (verified live):
 *   - missing/empty `url` → 400 (importURL AND importUUID)
 *   - non-whitelisted host or malformed URL → 404 (getHostFromUrl returns ''
 *     for unparseable URLs, which matches nothing)
 *   - provider fetch/parse failure → 500
 *
 * NOTE: the server writes nothing to disk itself - it streams the downloaded
 * file back to the caller, which then decides what to do with it (typically
 * feeding it into /api/characters/import or /api/worldinfo/import).
 */

const CONTENT_BASE = '/api/content';

/**
 * @typedef {object} ImportedContent
 * @property {Buffer} buffer raw file bytes (PNG card, JSON lorebook, ...)
 * @property {'character'|'lorebook'} contentType value of X-Custom-Content-Type
 * @property {string|null} fileName suggested file name from Content-Disposition
 * @property {string|null} mimeType Content-Type reported by the provider
 * @property {Record<string,string>} headers all response headers (lower-cased keys)
 */

export class ContentApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Import by a full content URL.
     * Endpoint: POST /api/content/importURL {url}.
     *
     * @param {object} params
     * @param {string} params.url e.g. 'https://www.chub.ai/characters/<slug>'
     * @returns {Promise<ImportedContent>}
     * @throws {TypeError} client-side when url is missing/empty
     * @throws {import('../core/client.js').StApiError} 400 missing url, 404
     *   non-whitelisted host, 500 provider/download failure
     */
    async importURL(params = {}) {
        if (typeof params !== 'object' || params === null) {
            throw new TypeError('ContentApi.importURL: expected an options object with a \'url\'');
        }
        // url validation is left to the server (it answers a descriptive 400
        // when the field is missing/empty, so the real API behavior stays visible)
        const res = await this.client.postWithResponse(`${CONTENT_BASE}/importURL`, { url: params.url });
        return this.#toImported(res);
    }

    /**
     * Import by provider-specific UUID/slug.
     * Endpoint: POST /api/content/importUUID {url} - despite the field name the
     * server expects the raw UUID/slug here, NOT a URL. Recognized shapes
     * (verified in source): '<uuid>_character' (Janitor), a bare 36-char UUID
     * (Pygmalion), 'AICC/<author>/<card>', Perchance slugs, anything else
     * falls through to Chub.
     *
     * @param {object} params
     * @param {string} params.url the UUID or slug
     * @returns {Promise<ImportedContent>}
     * @throws {TypeError} client-side when url is missing/empty
     * @throws {import('../core/client.js').StApiError} 400 missing url, 404
     *   unresolvable, 500 provider/download failure
     */
    async importUUID(params = {}) {
        if (typeof params !== 'object' || params === null) {
            throw new TypeError('ContentApi.importUUID: expected an options object with a \'url\'');
        }
        // same as importURL: the server validates the field (400)
        const res = await this.client.postWithResponse(`${CONTENT_BASE}/importUUID`, { url: params.url });
        return this.#toImported(res);
    }

    /**
     * Normalize the raw response into an ImportedContent object.
     * @param {{status:number, headers:Record<string,string>, buffer:Buffer}} res
     * @returns {ImportedContent}
     */
    #toImported(res) {
        const disposition = res.headers['content-disposition'] ?? '';
        const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
        return {
            buffer: res.buffer,
            contentType: res.headers['x-custom-content-type'] ?? null,
            fileName: nameMatch ? decodeURI(nameMatch[1]) : null,
            mimeType: res.headers['content-type'] ?? null,
            headers: res.headers,
        };
    }
}
