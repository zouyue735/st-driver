/**
 * Stable Diffusion API wrapper for SillyTavern (ST 1.18.0).
 *
 * All routes are POST under /api/sd/*. ST is a thin proxy to an SD WebUI /
 * SD.Next / ComfyUI backend: every request carries the backend `url` and an
 * optional basic-auth `auth` string ('user:pass'), and ST forwards the call.
 *
 * Verified against src/endpoints/stable-diffusion.js (only these 10 routes
 * exist in 1.18.0 - earlier docs mentioning /sizes or /workflows do NOT match
 * this version):
 *   ping, upscalers, vaes, samplers, schedulers, models, get-model, set-model,
 *   generate, sd-next/upscalers
 *
 * Without a configured SD backend, `ping` answers 500 (the handler throws on an
 * unreachable/empty url) - the tests assert that error path rather than
 * requiring a live SD server.
 */

const SD_BASE = '/api/sd';

export class StableDiffusionApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Probe the SD backend.
     * Endpoint: POST /api/sd/ping {url, auth?}
     * @param {object} params
     * @param {string} params.url SD WebUI base URL (required)
     * @param {string} [params.auth] 'user:pass' for HTTP basic auth
     * @returns {Promise<string|null>} empty body on success (200)
     * @throws {TypeError} when url is missing
     * @throws {import('../core/client.js').StApiError} 500 when unreachable
     */
    async ping(params = {}) {
        this.#requireUrl(params, 'ping');
        return await this.client.post(`${SD_BASE}/ping`, { url: params.url, auth: params.auth });
    }

    /**
     * List samplers. POST /api/sd/samplers {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async samplers(params = {}) {
        this.#requireUrl(params, 'samplers');
        return await this.client.post(`${SD_BASE}/samplers`, { url: params.url, auth: params.auth });
    }

    /**
     * List schedulers. POST /api/sd/schedulers {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async schedulers(params = {}) {
        this.#requireUrl(params, 'schedulers');
        return await this.client.post(`${SD_BASE}/schedulers`, { url: params.url, auth: params.auth });
    }

    /**
     * List models (checkpoints). POST /api/sd/models {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async models(params = {}) {
        this.#requireUrl(params, 'models');
        return await this.client.post(`${SD_BASE}/models`, { url: params.url, auth: params.auth });
    }

    /**
     * List VAEs. POST /api/sd/vaes {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async vaes(params = {}) {
        this.#requireUrl(params, 'vaes');
        return await this.client.post(`${SD_BASE}/vaes`, { url: params.url, auth: params.auth });
    }

    /**
     * List upscalers. POST /api/sd/upscalers {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async upscalers(params = {}) {
        this.#requireUrl(params, 'upscalers');
        return await this.client.post(`${SD_BASE}/upscalers`, { url: params.url, auth: params.auth });
    }

    /**
     * List SD.Next upscalers. POST /api/sd/sd-next/upscalers {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async sdNextUpscalers(params = {}) {
        this.#requireUrl(params, 'sdNextUpscalers');
        return await this.client.post(`${SD_BASE}/sd-next/upscalers`, { url: params.url, auth: params.auth });
    }

    /**
     * Get the active model. POST /api/sd/get-model {url, auth?}
     * @param {object} params {url, auth?}
     * @returns {Promise<any>}
     */
    async getModel(params = {}) {
        this.#requireUrl(params, 'getModel');
        return await this.client.post(`${SD_BASE}/get-model`, { url: params.url, auth: params.auth });
    }

    /**
     * Set the active model. POST /api/sd/set-model {url, auth?, model}
     * @param {object} params
     * @param {string} params.url
     * @param {string} [params.auth]
     * @param {string} params.model model/checkpoint name (required)
     * @returns {Promise<any>}
     * @throws {TypeError} when url or model is missing
     */
    async setModel(params = {}) {
        this.#requireUrl(params, 'setModel');
        if (!params.model) {
            throw new TypeError('StableDiffusionApi.setModel: \'model\' is required');
        }
        return await this.client.post(`${SD_BASE}/set-model`, {
            url: params.url, auth: params.auth, model: params.model,
        });
    }

    /**
     * Generate an image. POST /api/sd/generate
     *
     * The body is forwarded to the SD backend's txt2img endpoint almost
     * verbatim, so it accepts the standard A1111 payload PLUS the ST-specific
     * `url`/`auth` routing fields. Common fields (all optional except url):
     * prompt, negative_prompt, steps, cfg_scale, width, height, sampler_name,
     * scheduler, seed, batch_size, n_iter, override_settings, etc.
     *
     * @param {object} params
     * @param {string} params.url SD WebUI base URL (required)
     * @param {string} [params.auth] 'user:pass'
     * @param {string} [params.prompt]
     * @param {string} [params.negative_prompt]
     * @param {number} [params.steps]
     * @param {number} [params.cfg_scale]
     * @param {number} [params.width]
     * @param {number} [params.height]
     * @param {string} [params.sampler_name]
     * @param {number} [params.seed]
     * @param {...any} [params.rest] any other txt2img field is passed through
     * @returns {Promise<any>} the SD backend response (contains base64 images)
     * @throws {TypeError} when url is missing
     * @throws {import('../core/client.js').StApiError} 500 when the backend errors
     */
    async generate(params = {}) {
        this.#requireUrl(params, 'generate');
        // pass the whole payload through; ST forwards it to txt2img
        return await this.client.post(`${SD_BASE}/generate`, { ...params });
    }

    #requireUrl(params, label) {
        if (!params || typeof params !== 'object') {
            throw new TypeError(`StableDiffusionApi.${label}: expected an options object with a 'url'`);
        }
        if (!params.url || !String(params.url).length) {
            throw new TypeError(`StableDiffusionApi.${label}: 'url' (SD backend base URL) is required`);
        }
    }
}
