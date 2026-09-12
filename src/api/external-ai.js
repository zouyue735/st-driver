/**
 * External-AI helper endpoints: translate, caption, classify, speech.
 * Namespace module - exports TranslateApi, CaptionApi, ClassifyApi, SpeechApi.
 *
 * These are ST's proxies to translation/vision/classification/TTS services.
 * Most require either a configured secret (libre_url, deepl key, ...) or ST's
 * bundled local models (extras). Without configuration they answer errors -
 * the wrapper passes provider failures through as StApiError or as the
 * server's own error payload (verified per endpoint).
 */

/**
 * Translation providers, each its own POST route under /api/translate.
 * Body for all: {text, lang} where lang is the TARGET language code.
 * Response: PLAIN TEXT translated string (not JSON).
 */
export const TRANSLATE_PROVIDERS = Object.freeze([
    'libre', 'google', 'yandex', 'lingva', 'deepl', 'onering', 'deeplx', 'bing',
]);

export class TranslateApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Translate text with a specific provider.
     * @param {object} params
     * @param {string} params.text source text (required, non-empty)
     * @param {string} params.lang target language code (e.g. 'en', 'zh', 'de').
     *   NOTE (verified): 'zh-CN' is normalized to 'zh' server-side for libre.
     * @param {string} [params.provider='libre'] one of TRANSLATE_PROVIDERS
     * @returns {Promise<string>} plain-text translation
     * @throws {TypeError} on missing text/lang or unknown provider
     */
    async translate(params = {}) {
        const provider = params.provider ?? 'libre';
        if (!TRANSLATE_PROVIDERS.includes(provider)) {
            throw new TypeError(
                `TranslateApi: unknown provider '${provider}'. Valid: ${TRANSLATE_PROVIDERS.join(', ')}`,
            );
        }
        if (!params.text || !String(params.text).length) {
            throw new TypeError('TranslateApi.translate: \'text\' is required');
        }
        if (!params.lang || !String(params.lang).length) {
            throw new TypeError('TranslateApi.translate: \'lang\' (target language) is required');
        }
        return (await this.client.postRaw(`/api/translate/${provider}`, {
            text: params.text,
            lang: params.lang,
        })).trim();
    }
}

export class CaptionApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Caption an image with the configured vision source (or ST's local
     * transformers.js image-to-text pipeline).
     * Endpoint: POST /api/extra/caption/ {image}
     * @param {object} params
     * @param {string} params.image image URL or data URI (required)
     * @param {string} [params.prompt] caption prompt/instruction
     * @returns {Promise<{caption:string}>}
     * @throws {TypeError} when image is missing
     */
    async caption(params = {}) {
        if (!params.image) {
            throw new TypeError('CaptionApi.caption: \'image\' (URL or data URI) is required');
        }
        const body = { image: params.image };
        if (params.prompt !== undefined) body.prompt = params.prompt;
        return await this.client.post('/api/extra/caption/', body);
    }
}

export class ClassifyApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * List the sentiment/emotion classification labels.
     * Endpoint: POST /api/extra/classify/labels
     * @returns {Promise<{labels:string[]}>}
     */
    async labels() {
        return await this.client.post('/api/extra/classify/labels', {});
    }

    /**
     * Classify text (top-5 labels with scores, sorted).
     * Endpoint: POST /api/extra/classify/ {text}
     * @param {object} params
     * @param {string} params.text (required)
     * @returns {Promise<{classification:Array<{label:string, score:number}>}>}
     * @throws {TypeError} when text is missing
     */
    async classify(params = {}) {
        if (!params.text && params.text !== '') {
            throw new TypeError('ClassifyApi.classify: \'text\' is required');
        }
        return await this.client.post('/api/extra/classify/', { text: params.text });
    }
}

export class SpeechApi {
    /** @param {import('../core/client.js').STClient} client */
    constructor(client) {
        this.client = client;
    }

    /**
     * Speech-to-text with ST's local whisper (extras).
     * Endpoint: POST /api/speech/recognize {model, audio, lang?}
     * @param {object} params
     * @param {string} params.model whisper model name (e.g. 'Xenova/whisper-tiny.en')
     * @param {string} params.audio base64 data URI of the audio (required)
     * @param {string} [params.lang]
     * @returns {Promise<{text:string}>}
     * @throws {TypeError} when audio is missing
     */
    async recognize(params = {}) {
        if (!params.audio) {
            throw new TypeError('SpeechApi.recognize: \'audio\' (base64 data URI) is required');
        }
        const body = { audio: params.audio };
        if (params.model !== undefined) body.model = params.model;
        if (params.lang !== undefined) body.lang = params.lang;
        return await this.client.post('/api/speech/recognize', body);
    }

    /**
     * Text-to-speech with ST's local TTS (extras).
     * Endpoint: POST /api/speech/synthesize {text, model, speaker?}
     * @param {object} params
     * @param {string} params.text (required)
     * @param {string} [params.model]
     * @param {string} [params.speaker]
     * @returns {Promise<Buffer>} WAV audio bytes
     * @throws {TypeError} when text is missing
     */
    async synthesize(params = {}) {
        if (!params.text && params.text !== '') {
            throw new TypeError('SpeechApi.synthesize: \'text\' is required');
        }
        const body = { text: params.text };
        if (params.model !== undefined) body.model = params.model;
        if (params.speaker !== undefined) body.speaker = params.speaker;
        return await this.client.postBinary('/api/speech/synthesize', body);
    }
}
