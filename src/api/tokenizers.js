/**
 * TokenizersApi - /api/tokenizers/* endpoints
 * (ST 1.18.0, src/endpoints/tokenizers.js).
 *
 * Route families:
 *  - POST /api/tokenizers/<model>/encode  body {text}  -> {ids,count,chunks}
 *  - POST /api/tokenizers/<model>/decode  body {ids}   -> {text,chunks?}
 *  - POST /api/tokenizers/openai/encode|decode|count?model=<model>
 *  - POST /api/tokenizers/remote/kobold/count              {text,url}
 *  - POST /api/tokenizers/remote/textgenerationwebui/encode {text,url,model?,api_type?}
 *
 * Models are backed by three engines server-side:
 *  - Sentencepiece (.model files shipped with ST)
 *  - tiktoken (gpt2; the openai/* routes pick the encoding per model name)
 *  - @agnai/web-tokenizers JSON files (some downloaded on first use)
 */

/** Sentencepiece-backed model routes. */
export const SENTENCEPIECE_MODELS = Object.freeze([
    'llama', 'nerdstash', 'nerdstash_v2', 'mistral', 'yi', 'gemma', 'jamba',
]);

/** tiktoken-backed model routes. */
export const TIKTOKEN_MODELS = Object.freeze(['gpt2']);

/** @agnai/web-tokenizers-backed model routes. */
export const WEB_MODELS = Object.freeze([
    'claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek',
]);

/** Every directly routable <model> segment of encode/decode. */
export const TOKENIZER_MODELS = Object.freeze([
    ...SENTENCEPIECE_MODELS, ...TIKTOKEN_MODELS, ...WEB_MODELS,
]);

/**
 * @typedef {object} EncodeResult
 * @property {number[]} ids token ids
 * @property {number} count number of tokens
 * @property {string[]} chunks decoded text piece per token
 */

export class TokenizersApi {
    /** @param {import('../core/client.js').STClient} client connected ST client */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/tokenizers/<model>/encode - tokenize text.
     * @param {string} model one of TOKENIZER_MODELS (also accepts any string:
     *   the server routes by substring for its openai/* endpoints, but the
     *   direct <model> routes must match exactly)
     * @param {string} text text to tokenize
     * @returns {Promise<EncodeResult>}
     */
    async encode(model, text) {
        return await this.client.post(`/api/tokenizers/${encodeURIComponent(model)}/encode`, { text });
    }

    /**
     * POST /api/tokenizers/<model>/decode - detokenize ids.
     * @param {string} model one of TOKENIZER_MODELS
     * @param {number[]} ids token ids
     * @returns {Promise<{text: string, chunks?: string[]}>}
     */
    async decode(model, ids) {
        return await this.client.post(`/api/tokenizers/${encodeURIComponent(model)}/decode`, { ids });
    }

    /**
     * POST /api/tokenizers/openai/count?model=<model> - count tokens for a
     * chat messages array. The server selects the engine from the model name
     * (gpt-* -> tiktoken, claude/llama3/qwen2/... -> web tokenizers, unknown
     * -> gpt-3.5-turbo).
     * @param {string|undefined} model chat model name (query parameter; omit for default)
     * @param {Array<{role?: string, content?: string, name?: string}>} messages chat messages
     * @returns {Promise<{token_count: number}>}
     */
    async openaiCount(model, messages) {
        const query = model !== undefined && model !== null
            ? `?model=${encodeURIComponent(model)}`
            : '';
        return await this.client.post(`/api/tokenizers/openai/count${query}`, messages);
    }

    /**
     * POST /api/tokenizers/openai/encode?model=<model> - encode via the
     * model-dispatching openai route.
     * @param {string|undefined} model query parameter model name
     * @param {string} text text to encode
     * @returns {Promise<EncodeResult>}
     */
    async openaiEncode(model, text) {
        const query = model !== undefined && model !== null
            ? `?model=${encodeURIComponent(model)}`
            : '';
        return await this.client.post(`/api/tokenizers/openai/encode${query}`, { text });
    }

    /**
     * POST /api/tokenizers/openai/decode?model=<model> - decode via the
     * model-dispatching openai route.
     * @param {string|undefined} model query parameter model name
     * @param {number[]} ids token ids
     * @returns {Promise<{text: string, chunks?: string[]}>}
     */
    async openaiDecode(model, ids) {
        const query = model !== undefined && model !== null
            ? `?model=${encodeURIComponent(model)}`
            : '';
        return await this.client.post(`/api/tokenizers/openai/decode${query}`, { ids });
    }

    /**
     * POST /api/tokenizers/remote/kobold/count - ask a remote KoboldAI-style
     * server for a token count. Without a reachable service the ST server
     * answers {error:true} (200) instead of throwing.
     * @param {string} text prompt text
     * @param {string} url remote server base url
     * @returns {Promise<{count?: number, ids?: number[], error?: true}>}
     */
    async remoteKoboldCount(text, url) {
        return await this.client.post('/api/tokenizers/remote/kobold/count', { text, url });
    }

    /**
     * POST /api/tokenizers/remote/textgenerationwebui/encode - ask a remote
     * text-generation backend for a token count. Without a reachable service
     * the ST server answers {error:true} (200).
     * @param {string} text prompt text
     * @param {string} url remote server base url
     * @param {object} [options]
     * @param {string} [options.model] model name (for vllm/llamacpp/aphrodite)
     * @param {string} [options.api_type] one of ST's TEXTGEN_TYPES
     *   ('tabby', 'koboldcpp', 'llamacpp', 'vllm', 'aphrodite', ...)
     * @returns {Promise<{count?: number, ids?: number[], error?: true}>}
     */
    async remoteTextgenEncode(text, url, options = {}) {
        return await this.client.post('/api/tokenizers/remote/textgenerationwebui/encode', {
            text,
            url,
            model: options.model,
            api_type: options.api_type,
        });
    }
}
