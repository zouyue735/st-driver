/**
 * Web-search and AI-Horde API wrappers for SillyTavern (ST 1.18.0).
 * Namespace module - exports SearchApi and HordeApi.
 *
 * SEARCH (/api/search/*): each provider is its own POST route. Most need an
 * external API key configured via secrets (tavily, serper, serpapi, zai) or a
 * running searxng/koboldcpp instance; without configuration the server answers
 * 400 (missing query/baseUrl) or a provider error. Field names verified against
 * src/endpoints/search.js.
 *
 * HORDE (/api/horde/*): proxy to aihorde.net. Anonymous use is allowed for some
 * endpoints (text-models, sd-models, status) with a shared key; user-info and
 * generation read the stored `api_key_horde` secret. `generate-text` /
 * `generate-image` submit async jobs (poll with task-status). Generation
 * endpoints are gated in tests because they consume Horde Kudos.
 */

const SEARCH_BASE = '/api/search';
const HORDE_BASE = '/api/horde';

/** Search providers that take a simple {query} body. */
export const QUERY_PROVIDERS = Object.freeze(['tavily', 'serper', 'serpapi', 'zai', 'searxng', 'koboldcpp']);

export class SearchApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Tavily search. POST /api/search/tavily {query, include_images?}
     * @param {object} params
     * @param {string} params.query (required)
     * @param {boolean} [params.includeImages]
     * @returns {Promise<any>}
     */
    async tavily(params = {}) {
        this.#requireQuery(params, 'tavily');
        return await this.client.post(`${SEARCH_BASE}/tavily`, {
            query: params.query, include_images: params.includeImages,
        });
    }

    /**
     * Serper (Google) search. POST /api/search/serper {query, images?}
     * @param {object} params {query (required), images?}
     * @returns {Promise<any>}
     */
    async serper(params = {}) {
        this.#requireQuery(params, 'serper');
        return await this.client.post(`${SEARCH_BASE}/serper`, { query: params.query, images: params.images });
    }

    /**
     * SerpAPI search. POST /api/search/serpapi {query}
     * @param {object} params {query (required)}
     * @returns {Promise<any>}
     */
    async serpapi(params = {}) {
        this.#requireQuery(params, 'serpapi');
        return await this.client.post(`${SEARCH_BASE}/serpapi`, { query: params.query });
    }

    /**
     * Z.AI web search. POST /api/search/zai {query}
     * @param {object} params {query (required)}
     * @returns {Promise<any>}
     */
    async zai(params = {}) {
        this.#requireQuery(params, 'zai');
        return await this.client.post(`${SEARCH_BASE}/zai`, { query: params.query });
    }

    /**
     * SearXNG search. POST /api/search/searxng {baseUrl, query, preferences?, categories?}
     * @param {object} params
     * @param {string} params.baseUrl SearXNG instance URL (required)
     * @param {string} params.query (required)
     * @param {object} [params.preferences]
     * @param {string[]} [params.categories]
     * @returns {Promise<any>}
     */
    async searxng(params = {}) {
        if (!params.baseUrl) throw new TypeError('SearchApi.searxng: \'baseUrl\' is required');
        this.#requireQuery(params, 'searxng');
        return await this.client.post(`${SEARCH_BASE}/searxng`, {
            baseUrl: params.baseUrl, query: params.query,
            preferences: params.preferences, categories: params.categories,
        });
    }

    /**
     * KoboldCpp web-search tool. POST /api/search/koboldcpp {query, url}
     * @param {object} params {query (required), url (koboldcpp base URL, required)}
     * @returns {Promise<any>}
     */
    async koboldcpp(params = {}) {
        if (!params.url) throw new TypeError('SearchApi.koboldcpp: \'url\' is required');
        this.#requireQuery(params, 'koboldcpp');
        return await this.client.post(`${SEARCH_BASE}/koboldcpp`, { query: params.query, url: params.url });
    }

    /**
     * Fetch a web page and extract readable content.
     * POST /api/search/visit {url, html?}
     * @param {object} params
     * @param {string} params.url (required)
     * @param {boolean} [params.html=true]
     * @returns {Promise<any>}
     */
    async visit(params = {}) {
        if (!params.url) throw new TypeError('SearchApi.visit: \'url\' is required');
        return await this.client.post(`${SEARCH_BASE}/visit`, { url: params.url, html: params.html ?? true });
    }

    /**
     * Fetch a YouTube transcript. POST /api/search/transcript {id, lang?, json?}
     * @param {object} params
     * @param {string} params.id video id (required)
     * @param {string} [params.lang]
     * @param {boolean} [params.json]
     * @returns {Promise<any>}
     */
    async transcript(params = {}) {
        if (!params.id) throw new TypeError('SearchApi.transcript: \'id\' (video id) is required');
        return await this.client.post(`${SEARCH_BASE}/transcript`, {
            id: params.id, lang: params.lang, json: params.json,
        });
    }

    #requireQuery(params, label) {
        if (!params || typeof params !== 'object') {
            throw new TypeError(`SearchApi.${label}: expected an options object`);
        }
        if (!params.query || !String(params.query).length) {
            throw new TypeError(`SearchApi.${label}: 'query' is required`);
        }
    }
}

export class HordeApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Horde service heartbeat. POST /api/horde/status (no body).
     * @returns {Promise<any>}
     */
    async status() {
        return await this.client.post(`${HORDE_BASE}/status`, {});
    }

    /**
     * Current user info (reads the api_key_horde secret). POST /api/horde/user-info
     * @returns {Promise<any>}
     */
    async userInfo() {
        return await this.client.post(`${HORDE_BASE}/user-info`, {});
    }

    /**
     * List text-generation workers. POST /api/horde/text-workers {model?}
     * @param {object} [params] {model?}
     * @returns {Promise<any>}
     */
    async textWorkers(params = {}) {
        return await this.client.post(`${HORDE_BASE}/text-workers`, params ?? {});
    }

    /**
     * List available text models. POST /api/horde/text-models
     * @returns {Promise<any>}
     */
    async textModels() {
        return await this.client.post(`${HORDE_BASE}/text-models`, {});
    }

    /**
     * List SD samplers. POST /api/horde/sd-samplers
     * @returns {Promise<any>}
     */
    async sdSamplers() {
        return await this.client.post(`${HORDE_BASE}/sd-samplers`, {});
    }

    /**
     * List SD models. POST /api/horde/sd-models
     * @returns {Promise<any>}
     */
    async sdModels() {
        return await this.client.post(`${HORDE_BASE}/sd-models`, {});
    }

    /**
     * Submit a text-generation job. POST /api/horde/generate-text
     * Body is forwarded to the Horde API (prompt, params, models, ...).
     * Consumes Kudos - gated in tests.
     * @param {object} params Horde generate payload
     * @returns {Promise<any>} {ids, kudos}
     */
    async generateText(params = {}) {
        return await this.client.post(`${HORDE_BASE}/generate-text`, params);
    }

    /**
     * Submit an image-generation job. POST /api/horde/generate-image {prompt, ...}
     * Consumes Kudos - gated in tests.
     * @param {object} params {prompt (required), ...Horde image payload}
     * @returns {Promise<any>}
     * @throws {TypeError} when prompt is missing
     */
    async generateImage(params = {}) {
        if (!params.prompt) throw new TypeError('HordeApi.generateImage: \'prompt\' is required');
        return await this.client.post(`${HORDE_BASE}/generate-image`, params);
    }

    /**
     * Poll a job's status. POST /api/horde/task-status {taskId}
     * @param {object} params {taskId (required)}
     * @returns {Promise<any>}
     */
    async taskStatus(params = {}) {
        if (!params.taskId) throw new TypeError('HordeApi.taskStatus: \'taskId\' is required');
        return await this.client.post(`${HORDE_BASE}/task-status`, { taskId: params.taskId });
    }

    /**
     * Cancel a pending job. POST /api/horde/cancel-task {taskId}
     * @param {object} params {taskId (required)}
     * @returns {Promise<any>}
     */
    async cancelTask(params = {}) {
        if (!params.taskId) throw new TypeError('HordeApi.cancelTask: \'taskId\' is required');
        return await this.client.post(`${HORDE_BASE}/cancel-task`, { taskId: params.taskId });
    }

    /**
     * Caption an image via Horde. POST /api/horde/caption-image {image}
     * @param {object} params {image (data URI or URL, required)}
     * @returns {Promise<any>}
     */
    async captionImage(params = {}) {
        if (!params.image) throw new TypeError('HordeApi.captionImage: \'image\' is required');
        return await this.client.post(`${HORDE_BASE}/caption-image`, { image: params.image });
    }
}
