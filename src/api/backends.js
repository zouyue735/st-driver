/**
 * LLM backend proxy API wrapper for SillyTavern (ST 1.18.0).
 *
 * Covers three route families (mounts verified in src/server-startup.js):
 *   /api/backends/chat-completions/*  <- src/endpoints/backends/chat-completions.js
 *   /api/backends/text-completions/*  <- src/endpoints/backends/text-completions.js
 *   /api/backends/kobold/*            <- src/endpoints/backends/kobold.js
 *
 * IMPORTANT - these endpoints are raw PROXIES: ST forwards your payload to the
 * provider/local backend and passes the reply through. None of ST's prompt
 * pipeline runs here (no context template, world info, character card, regex,
 * personas). Build the whole `messages`/`prompt` yourself. For the full "Send
 * button" pipeline use the UI track (ctx.generate) instead.
 *
 * DANGEROUS SERVER QUIRK (verified live - crashed the ST process):
 *   POST /api/backends/kobold/status and /kobold/generate dereference
 *   `request.body.api_server.indexOf(...)` OUTSIDE any try/catch. Omitting
 *   api_server produces an unhandled promise rejection that KILLS the whole ST
 *   server. Every kobold method here therefore requires apiServer client-side
 *   and refuses to send the request without it.
 *   (For contrast: text-completions /status has the same dereference INSIDE
 *   try/catch -> 500, and /generate catches it -> 200 {error:true,
 *   status:'UNKNOWN', response:"Cannot read properties of undefined
 *   (reading 'indexOf')"}.)
 *
 * Live-verified response shapes (HTTP 200 unless noted):
 *   cc/status  ok            -> provider payload verbatim, e.g. deepseek:
 *                               {object:'list', data:[{id,object,owned_by}]}
 *   cc/status  provider fail -> {error:true, data:{data:[]}}   (NOT an HTTP error!)
 *   cc/status  fetch throw   -> {error:true}                   (soft, e.g. dead custom_url)
 *   cc/status  bad source    -> 400 {error:true}
 *   cc/status  missing key   -> 400 {error:true}
 *   cc/generate missing key  -> 400 {error:true}
 *   cc/generate fetch throw  -> 502 {error:{message, ...}}     (ECONNREFUSED etc.)
 *   cc/generate provider !ok -> 200 {error:{message}, quota_error}
 *   cc/bias    non-array     -> 400 (plain-text 'Bad Request')
 *   cc/process bad input     -> 400 {error:'Invalid messages format'|'Unknown processing type'}
 *   tc/status|props dead     -> 500 (plain-text 'Internal Server Error')
 *   tc/generate dead         -> {error:true, status:'ECONNREFUSED', response:'request to <routed url> failed...'}
 *   kobold/status dead       -> {koboldUnitedVersion:'0.0.0', model:'no_connection'}
 *                               (koboldCppVersion is ABSENT: source assigns
 *                               koboldExtraResponse.result but the /extra/version
 *                               fallback is {version:'0.0'} -> undefined)
 *   kobold/generate dead     -> {error:true}
 *   kobold/embed|transcribe dead -> 500 plain-text 'Internal server error'
 */

const CC_BASE = '/api/backends/chat-completions';
const TC_BASE = '/api/backends/text-completions';
const KOBOLD_BASE = '/api/backends/kobold';

/**
 * Valid `chat_completion_source` values.
 * Source: src/constants.js CHAT_COMPLETION_SOURCES (ST 1.18.0, 26 entries).
 * @type {ReadonlyArray<string>}
 */
export const CHAT_COMPLETION_SOURCES = Object.freeze([
    'openai', 'claude', 'openrouter', 'ai21', 'makersuite', 'vertexai',
    'mistralai', 'custom', 'cohere', 'perplexity', 'groq', 'chutes',
    'electronhub', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'pollinations',
    'moonshot', 'fireworks', 'cometapi', 'azure_openai', 'zai', 'siliconflow',
    'minimax', 'workers_ai',
]);

/**
 * Valid `type` values of POST /process.
 * Source: src/prompt-converters.js PROMPT_PROCESSING_TYPE (NONE is '').
 * @type {ReadonlyArray<string>}
 */
export const PROMPT_PROCESSING_TYPES = Object.freeze([
    '',             // NONE - passthrough
    'claude',       // CLAUDE (deprecated alias of merge)
    'merge',        // MERGE
    'merge_tools',  // MERGE_TOOLS
    'semi',         // SEMI
    'semi_tools',   // SEMI_TOOLS
    'strict',       // STRICT
    'strict_tools', // STRICT_TOOLS
    'single',       // SINGLE
]);

/**
 * camelCase driver option -> snake_case wire field for
 * POST /api/backends/chat-completions/generate (and /status where noted).
 *
 * EVERY entry cites the exact `request.body.<field>` read in
 * src/endpoints/backends/chat-completions.js. Fields the server reads but no
 * provider branch uses are still mapped so they pass through faithfully.
 */
export const GENERATE_FIELD_MAP = Object.freeze({
    // --- routing (switch on request.body.chat_completion_source, line ~2174)
    chatCompletionSource: 'chat_completion_source',
    // --- credentials / proxy (per-provider: `request.body.reverse_proxy ? request.body.proxy_password : readSecret(..., request.body.secret_id)`)
    secretId: 'secret_id',
    reverseProxy: 'reverse_proxy',
    proxyPassword: 'proxy_password',
    // --- custom source (CUSTOM branch: request.body.custom_url / custom_include_body / custom_include_headers / custom_exclude_body)
    customUrl: 'custom_url',
    customIncludeBody: 'custom_include_body',
    customIncludeHeaders: 'custom_include_headers',
    customExcludeBody: 'custom_exclude_body',
    // --- core OAI-shaped body (generic requestBody literal, lines ~2553-2570)
    messages: 'messages',                    // request.body.messages (string => text-completion mode)
    model: 'model',                          // request.body.model
    temperature: 'temperature',              // request.body.temperature
    maxTokens: 'max_tokens',                 // request.body.max_tokens
    maxCompletionTokens: 'max_completion_tokens', // request.body.max_completion_tokens (xAI + generic)
    stream: 'stream',                        // request.body.stream
    presencePenalty: 'presence_penalty',     // request.body.presence_penalty
    frequencyPenalty: 'frequency_penalty',   // request.body.frequency_penalty
    topP: 'top_p',                           // request.body.top_p
    topK: 'top_k',                           // request.body.top_k (Claude/generic/ElectronHub/Chutes)
    stop: 'stop',                            // request.body.stop
    logitBias: 'logit_bias',                 // request.body.logit_bias (generic/ElectronHub/Chutes)
    seed: 'seed',                            // request.body.seed
    n: 'n',                                  // request.body.n (xAI/AIMLAPI/generic)
    logprobs: 'logprobs',                    // request.body.logprobs (DeepSeek/xAI/AIMLAPI/Chutes/OpenAI)
    // --- OpenRouter-only extras (OPENROUTER branch, lines ~2216-2303)
    minP: 'min_p',                           // request.body.min_p
    topA: 'top_a',                           // request.body.top_a
    repetitionPenalty: 'repetition_penalty', // request.body.repetition_penalty (also Chutes/WorkersAI)
    provider: 'provider',                    // request.body.provider (order array)
    quantizations: 'quantizations',          // request.body.quantizations
    allowFallbacks: 'allow_fallbacks',       // request.body.allow_fallbacks
    useFallback: 'use_fallback',             // request.body.use_fallback -> route:'fallback'
    middleout: 'middleout',                  // request.body.middleout -> transforms ['middle-out']
    enableWebSearch: 'enable_web_search',    // request.body.enable_web_search (OpenRouter plugin / Claude web_search / Gemini google_search / nanogpt :online)
    // --- tools / structured output (generic + per-provider)
    tools: 'tools',                          // request.body.tools
    toolChoice: 'tool_choice',               // request.body.tool_choice
    jsonSchema: 'json_schema',               // request.body.json_schema {name, description, value, strict}
    customPromptPostProcessing: 'custom_prompt_post_processing', // request.body.custom_prompt_post_processing (generate handler head)
    // --- reasoning (DeepSeek/OpenRouter/xAI/AIMLAPI/Gemini/Claude branches)
    includeReasoning: 'include_reasoning',   // request.body.include_reasoning
    reasoningEffort: 'reasoning_effort',     // request.body.reasoning_effort
    verbosity: 'verbosity',                  // request.body.verbosity (Claude output_config.effort / OpenRouter / gpt-5)
    // --- Claude (sendClaudeRequest)
    useSysprompt: 'use_sysprompt',           // request.body.use_sysprompt
    assistantPrefill: 'assistant_prefill',   // request.body.assistant_prefill (convertClaudeMessages)
    // --- Mistral (sendMistralAIRequest)
    safePrompt: 'safe_prompt',               // request.body.safe_prompt
    // --- Gemini / Vertex AI (sendMakerSuiteRequest)
    requestImages: 'request_images',                       // request.body.request_images
    requestImageAspectRatio: 'request_image_aspect_ratio', // request.body.request_image_aspect_ratio
    requestImageResolution: 'request_image_resolution',    // request.body.request_image_resolution
    vertexaiRegion: 'vertexai_region',                     // request.body.vertexai_region
    vertexaiExpressProjectId: 'vertexai_express_project_id', // request.body.vertexai_express_project_id
    // QUIRK: these two stay camelCase on the wire - sendMakerSuiteRequest reads
    // `request.body.responseMimeType` / `request.body.responseSchema` literally.
    responseMimeType: 'responseMimeType',
    responseSchema: 'responseSchema',
    // --- NanoGPT (NANOGPT branch)
    nanogptProvider: 'nanogpt_provider',     // request.body.nanogpt_provider -> X-Provider header
    nanogptPaygOverride: 'nanogpt_payg_override', // request.body.nanogpt_payg_override -> X-Billing-Mode
    // --- Azure OpenAI (sendAzureOpenAIRequest destructuring)
    azureBaseUrl: 'azure_base_url',          // request.body.azure_base_url
    azureDeploymentName: 'azure_deployment_name', // request.body.azure_deployment_name
    azureApiVersion: 'azure_api_version',    // request.body.azure_api_version
    // --- Cloudflare Workers AI (WORKERS_AI branch)
    workersAiAccountId: 'workers_ai_account_id', // request.body.workers_ai_account_id
    // --- endpoint variants (status/generate branches)
    siliconflowEndpoint: 'siliconflow_endpoint', // request.body.siliconflow_endpoint
    zaiEndpoint: 'zai_endpoint',             // request.body.zai_endpoint
    minimaxEndpoint: 'minimax_endpoint',     // request.body.minimax_endpoint (sendMinimaxRequest)
    // --- prompt name substitution (getPromptNames, src/prompt-converters.js line ~49)
    charName: 'char_name',                   // request.body.char_name
    userName: 'user_name',                   // request.body.user_name
    groupNames: 'group_names',               // request.body.group_names
});

/**
 * camelCase -> snake_case for POST /api/backends/chat-completions/status.
 * Source: the /status handler's request.body reads (lines ~1735-2071).
 */
export const STATUS_FIELD_MAP = Object.freeze({
    chatCompletionSource: 'chat_completion_source', // request.body.chat_completion_source (branch switch)
    secretId: 'secret_id',                     // readSecret(..., request.body.secret_id)
    reverseProxy: 'reverse_proxy',             // request.body.reverse_proxy
    proxyPassword: 'proxy_password',           // request.body.proxy_password
    customUrl: 'custom_url',                   // CUSTOM branch: apiUrl = request.body.custom_url
    customIncludeHeaders: 'custom_include_headers', // CUSTOM branch: mergeObjectWithYaml(headers, ...)
    azureBaseUrl: 'azure_base_url',            // AZURE_OPENAI branch destructuring
    azureDeploymentName: 'azure_deployment_name',
    azureApiVersion: 'azure_api_version',
    workersAiAccountId: 'workers_ai_account_id', // WORKERS_AI branch
    siliconflowEndpoint: 'siliconflow_endpoint', // SILICONFLOW branch
});

/**
 * camelCase -> snake_case for the ST-specific fields of
 * POST /api/backends/text-completions/*. EVERY OTHER KEY IS PASSED THROUGH
 * VERBATIM by design: the handler forwards request.body to the backend and
 * whitelists per api_type (OPENAI_KEYS / OLLAMA_KEYS / TOGETHERAI_KEYS / ...
 * in src/constants.js), so sampler fields are already snake_case on input.
 * Source: handler reads request.body.api_server / api_type / secret_id and
 * forwards the rest; setAdditionalHeaders reads api_type + secret_id.
 */
export const TEXTGEN_FIELD_MAP = Object.freeze({
    apiServer: 'api_server',   // request.body.api_server (localhost->127.0.0.1 rewrite)
    apiType: 'api_type',       // request.body.api_type (TEXTGEN_TYPES routing switch)
    secretId: 'secret_id',     // setAdditionalHeaders -> request.body.secret_id
    model: 'model',            // forwarded; llamacpp /props uses request.body.model
    prompt: 'prompt',          // forwarded to the backend
    stream: 'stream',          // request.body.stream (SSE forwarding / ollama stream parser)
});

/**
 * camelCase -> snake_case for POST /api/backends/kobold/generate.
 * Source: src/endpoints/backends/kobold.js this_settings literal (lines ~40-81)
 * plus the streaming/abort fields read off request.body.
 */
export const KOBOLD_FIELD_MAP = Object.freeze({
    apiServer: 'api_server',                 // request.body.api_server (REQUIRED - see crash quirk)
    prompt: 'prompt',                        // request.body.prompt
    maxContextLength: 'max_context_length',  // request.body.max_context_length
    maxLength: 'max_length',                 // request.body.max_length
    guiSettings: 'gui_settings',             // request.body.gui_settings (truthy => skip sampler overrides)
    repPen: 'rep_pen',                       // request.body.rep_pen
    repPenRange: 'rep_pen_range',            // request.body.rep_pen_range
    repPenSlope: 'rep_pen_slope',            // request.body.rep_pen_slope
    temperature: 'temperature',              // request.body.temperature
    tfs: 'tfs',                              // request.body.tfs
    topA: 'top_a',                           // request.body.top_a
    topK: 'top_k',                           // request.body.top_k
    topP: 'top_p',                           // request.body.top_p
    minP: 'min_p',                           // request.body.min_p
    typical: 'typical',                      // request.body.typical
    samplerOrder: 'sampler_order',           // request.body.sampler_order
    singleline: 'singleline',                // !!request.body.singleline
    useDefaultBadwordsids: 'use_default_badwordsids', // request.body.use_default_badwordsids
    mirostat: 'mirostat',                    // request.body.mirostat
    mirostatEta: 'mirostat_eta',             // request.body.mirostat_eta
    mirostatTau: 'mirostat_tau',             // request.body.mirostat_tau
    grammar: 'grammar',                      // request.body.grammar
    samplerSeed: 'sampler_seed',             // request.body.sampler_seed
    stopSequence: 'stop_sequence',           // request.body.stop_sequence (only set when truthy)
    streaming: 'streaming',                  // request.body.streaming -> /extra/generate/stream (NOT `stream`!)
    canAbort: 'can_abort',                   // request.body.can_abort (socket-close abort hook)
    apiType: 'api_type',                     // setAdditionalHeaders -> request.body.api_type (koboldcpp auth header)
    secretId: 'secret_id',                   // setAdditionalHeaders -> request.body.secret_id
});

/**
 * Build a snake_case body from camelCase options using a field map.
 * - `undefined` values are omitted.
 * - unknown keys raise a TypeError (typo guard) UNLESS the map is TEXTGEN_FIELD_MAP
 *   (passthrough by design, see its doc).
 * - an `extra` object is merged verbatim (escape hatch for future ST fields).
 * Exported for pure unit tests - performs NO validation of required fields.
 *
 * @param {Record<string, any>} options camelCase driver options
 * @param {Record<string,string>} fieldMap camelCase -> snake_case map
 * @param {boolean} [passthroughUnknown=false] forward unknown keys as-is
 * @returns {Record<string, any>} the wire body
 */
function mapBody(options, fieldMap, passthroughUnknown = false) {
    const body = {};
    for (const [key, value] of Object.entries(options)) {
        if (value === undefined) continue;
        if (key === 'extra') {
            Object.assign(body, value);
            continue;
        }
        const wire = fieldMap[key];
        if (wire === undefined) {
            if (passthroughUnknown) {
                body[key] = value;
                continue;
            }
            throw new TypeError(
                `BackendsApi: unknown parameter '${key}' (known: ${Object.keys(fieldMap).join(', ')})`,
            );
        }
        body[wire] = value;
    }
    return body;
}

/**
 * Pure builder for the chat-completions /generate body (unknown keys rejected).
 * @param {Record<string, any>} options see GENERATE_FIELD_MAP
 * @returns {Record<string, any>} snake_case wire body
 */
export function buildGenerateBody(options) {
    return mapBody(options, GENERATE_FIELD_MAP);
}

/**
 * Pure builder for the chat-completions /status body (unknown keys rejected).
 * @param {Record<string, any>} options see STATUS_FIELD_MAP
 * @returns {Record<string, any>} snake_case wire body
 */
export function buildStatusBody(options) {
    return mapBody(options, STATUS_FIELD_MAP);
}

/**
 * Pure builder for the text-completions bodies (unknown keys PASS THROUGH -
 * the server whitelists per api_type and forwards the rest).
 * @param {Record<string, any>} options see TEXTGEN_FIELD_MAP
 * @returns {Record<string, any>} wire body
 */
export function buildTextgenBody(options) {
    return mapBody(options, TEXTGEN_FIELD_MAP, true);
}

/**
 * Pure builder for the kobold /generate body. REQUIRES apiServer: sending the
 * request without api_server crashes the ST server (see module header).
 * @param {Record<string, any>} options see KOBOLD_FIELD_MAP
 * @returns {Record<string, any>} snake_case wire body
 */
export function buildKoboldBody(options) {
    requireNonEmpty(options?.apiServer, 'apiServer', 'buildKoboldBody');
    return mapBody(options, KOBOLD_FIELD_MAP);
}

/**
 * Backward-compatible loose mapper: translate camelCase options to snake_case
 * using a field map, passing UNKNOWN keys through unchanged and dropping
 * undefined values. Unlike buildGenerateBody this never throws on unknown
 * keys, so it is safe for exploratory/forward-compatible payloads.
 *
 * @param {Record<string, any>} options camelCase driver options
 * @param {Record<string,string>} [fieldMap=GENERATE_FIELD_MAP] mapping table
 * @returns {Record<string, any>} the wire body
 */
export function mapFields(options, fieldMap = GENERATE_FIELD_MAP) {
    return mapBody(options, fieldMap, true);
}

/**
 * Throw a TypeError unless value is a non-empty (after trim) string.
 * @param {unknown} value
 * @param {string} label parameter name for the message
 * @param {string} where method/builder name for the message
 * @returns {string} the trimmed value
 */
function requireNonEmpty(value, label, where) {
    if (value === undefined || value === null) {
        throw new TypeError(`BackendsApi.${where}: '${label}' is required (got ${value})`);
    }
    const str = String(value);
    if (!str.trim().length) {
        throw new TypeError(`BackendsApi.${where}: '${label}' must be a non-empty string`);
    }
    return str;
}

/**
 * @typedef {object} ChatCompletionMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array} content
 * @property {string} [name]
 */

/**
 * High-level wrapper around ST's LLM backend proxy endpoints.
 * All methods are raw proxies - ST's prompt pipeline does NOT run.
 */
export class BackendsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    // ---------------------------------------------------------------- chat completions

    /**
     * Test the provider connection and list its models.
     * Endpoint: POST /api/backends/chat-completions/status
     *
     * QUIRK: a provider-side failure is NOT an HTTP error. Bad key / non-OK
     * models endpoint answers 200 {error:true, data:{data:[]}}; a thrown fetch
     * (dead custom_url) answers 200 {error:true}. Check the `error` key.
     *
     * @param {object} params
     * @param {string} params.chatCompletionSource one of CHAT_COMPLETION_SOURCES
     * @param {string} [params.secretId] which stored secret to use
     * @param {string} [params.reverseProxy] provider base-URL override
     * @param {string} [params.proxyPassword] key used with reverseProxy
     * @param {string} [params.customUrl] CUSTOM source endpoint
     * @param {string} [params.customIncludeHeaders] YAML merged into the headers
     * @param {string} [params.azureBaseUrl] Azure OpenAI resource URL
     * @param {string} [params.azureDeploymentName] Azure deployment
     * @param {string} [params.azureApiVersion] Azure api-version
     * @param {string} [params.workersAiAccountId] Cloudflare account id
     * @param {string} [params.siliconflowEndpoint] '' (global) or CN endpoint
     * @returns {Promise<any>} provider models payload, e.g. deepseek:
     *   {object:'list', data:[{id, object:'model', owned_by}]}, or a soft
     *   error {error:true, data?:{data:[]}}
     * @throws {TypeError} client-side on a missing/unknown chatCompletionSource
     * @throws {import('../core/client.js').StApiError} 400 {error:true} on a
     *   missing API key or an unsupported source
     */
    async chatCompletionsStatus(params = {}) {
        this.#assertSource(params?.chatCompletionSource, 'chatCompletionsStatus');
        return await this.client.post(`${CC_BASE}/status`, buildStatusBody(params));
    }

    /**
     * Generate through the provider proxy (non-streaming).
     * Endpoint: POST /api/backends/chat-completions/generate
     *
     * Every parameter is mapped camelCase -> snake_case per GENERATE_FIELD_MAP
     * (each entry cites its request.body read in the ST source). Unknown
     * parameters raise a client-side TypeError; use `extra: {...}` to forward
     * future fields verbatim.
     *
     * @param {object} params
     * @param {string} params.chatCompletionSource REQUIRED, one of CHAT_COMPLETION_SOURCES
     * @param {ChatCompletionMessage[]|string} params.messages REQUIRED (a plain
     *   string switches the generic path into text-completion mode)
     * @param {string} params.model REQUIRED
     * @param {number} [params.temperature]
     * @param {number} [params.topP]
     * @param {number} [params.topK]
     * @param {number} [params.maxTokens]
     * @param {number} [params.maxCompletionTokens]
     * @param {number} [params.presencePenalty]
     * @param {number} [params.frequencyPenalty]
     * @param {number} [params.minP]
     * @param {number} [params.topA]
     * @param {number} [params.repetitionPenalty]
     * @param {number} [params.seed]
     * @param {number} [params.n]
     * @param {string[]} [params.stop]
     * @param {Record<string,number>} [params.logitBias]
     * @param {number} [params.logprobs]
     * @param {Array} [params.tools] function-calling tool definitions
     * @param {string|object} [params.toolChoice]
     * @param {{name:string, description?:string, strict?:boolean, value:object}} [params.jsonSchema]
     * @param {boolean} [params.includeReasoning]
     * @param {string} [params.reasoningEffort]
     * @param {string} [params.verbosity]
     * @param {boolean} [params.useSysprompt]
     * @param {string} [params.assistantPrefill]
     * @param {boolean} [params.enableWebSearch]
     * @param {string} [params.secretId]
     * @param {string} [params.reverseProxy]
     * @param {string} [params.proxyPassword]
     * @param {string} [params.customUrl]
     * @param {string} [params.customIncludeBody] YAML merged into the body
     * @param {string} [params.customIncludeHeaders] YAML merged into the headers
     * @param {string} [params.customExcludeBody] YAML removed from the body
     * @param {string} [params.customPromptPostProcessing] one of PROMPT_PROCESSING_TYPES
     * @param {Record<string, any>} [params.extra] extra wire fields, merged verbatim
     * @returns {Promise<any>} the provider's chat-completion JSON passed
     *   through ({id, choices:[{message:{content}}], usage, ...}); on a
     *   provider non-OK reply: 200 {error:{message}, quota_error}
     * @throws {TypeError} client-side on a missing/unknown source, missing
     *   messages/model, unknown parameters, or stream=true
     * @throws {import('../core/client.js').StApiError} 400 {error:true} on a
     *   missing key; 502 {error:{message}} when the provider fetch throws
     */
    async chatCompletionsGenerate(params = {}) {
        this.#assertGenerateParams(params);
        if (params.stream) {
            throw new TypeError(
                'BackendsApi.chatCompletionsGenerate: stream=true returns an SSE stream; ' +
                'call chatCompletionsGenerateStream() instead',
            );
        }
        return await this.client.post(`${CC_BASE}/generate`, buildGenerateBody(params));
    }

    /**
     * Streaming variant of chatCompletionsGenerate: returns the raw SSE text
     * forwarded from the provider (`data: {...}` chunks, terminated by
     * `data: [DONE]`). Caller parses the stream.
     * @param {object} params same as chatCompletionsGenerate; `stream` is forced true
     * @returns {Promise<string>} the raw SSE payload
     * @throws {TypeError} same client-side validation as chatCompletionsGenerate
     */
    async chatCompletionsGenerateStream(params = {}) {
        this.#assertGenerateParams(params);
        return await this.client.postRaw(`${CC_BASE}/generate`, buildGenerateBody({ ...params, stream: true }));
    }

    /**
     * Build a logit_bias map from text/value pairs. FREE (tokenizer only).
     * Endpoint: POST /api/backends/chat-completions/bias?model=<model>
     *
     * QUIRKS (verified against source + live):
     * - the request BODY IS A BARE ARRAY of {text, value} - not an object;
     *   the model travels in the QUERY string.
     * - model is optional: '' falls back to the default cl100k tokenizer
     *   (getTokenizerModel('') -> 'gpt-3.5-turbo').
     * - a model containing 'claude' short-circuits to {}.
     * - an entry whose `text` is a JSON array of numbers ('[15496, 11]') uses
     *   those token ids verbatim instead of tokenizing.
     * - entries without text are skipped; a plain string entry is normalized
     *   by THIS wrapper to {text, value: -100} (ban shorthand).
     *
     * @param {Array<{text:string, value:number}|string>} entries bias entries
     * @param {string} [model] model name for tokenizer selection (query param)
     * @returns {Promise<Record<string,number>>} token-id (string) -> bias value
     * @throws {TypeError} client-side when entries is not an array
     */
    async chatCompletionsBias(entries, model) {
        if (!Array.isArray(entries)) {
            throw new TypeError('BackendsApi.chatCompletionsBias: entries must be an array of {text, value}');
        }
        const body = entries.map(entry => typeof entry === 'string' ? { text: entry, value: -100 } : entry);
        const query = model !== undefined && model !== null && String(model).length
            ? `?model=${encodeURIComponent(model)}`
            : '';
        return await this.client.post(`${CC_BASE}/bias${query}`, body);
    }

    /**
     * Apply ST's prompt post-processing to a message array. FREE (no LLM call).
     * Endpoint: POST /api/backends/chat-completions/process
     *
     * @param {object} params
     * @param {ChatCompletionMessage[]} params.messages REQUIRED
     * @param {string} params.type REQUIRED, one of PROMPT_PROCESSING_TYPES -
     *   note '' (NONE) IS a valid value (passthrough)
     * @param {string} [params.charName] -> char_name ({{char}} substitution in
     *   getPromptNames, src/prompt-converters.js)
     * @param {string} [params.userName] -> user_name
     * @param {string[]} [params.groupNames] -> group_names
     * @returns {Promise<{messages: ChatCompletionMessage[]}>}
     * @throws {TypeError} client-side on non-array messages, a missing or
     *   invalid type, or unknown parameters
     * @throws {import('../core/client.js').StApiError} 400 {error:'Invalid
     *   messages format'|'Unknown processing type'} when bypassing the guards
     */
    async chatCompletionsProcess(params = {}) {
        if (!Array.isArray(params?.messages)) {
            throw new TypeError("BackendsApi.chatCompletionsProcess: 'messages' must be an array");
        }
        if (params.type === undefined || params.type === null) {
            throw new TypeError("BackendsApi.chatCompletionsProcess: 'type' is required (one of PROMPT_PROCESSING_TYPES, '' included)");
        }
        if (!PROMPT_PROCESSING_TYPES.includes(params.type)) {
            throw new TypeError(
                `BackendsApi.chatCompletionsProcess: invalid type '${params.type}'. ` +
                `Valid: ${JSON.stringify([...PROMPT_PROCESSING_TYPES])}`,
            );
        }
        const body = mapBody(params, {
            messages: 'messages',       // handler: Array.isArray(request.body.messages)
            type: 'type',               // handler: Object.values(PROMPT_PROCESSING_TYPE).includes(request.body.type)
            charName: 'char_name',      // getPromptNames: request.body.char_name
            userName: 'user_name',      // getPromptNames: request.body.user_name
            groupNames: 'group_names',  // getPromptNames: request.body.group_names
        });
        return await this.client.post(`${CC_BASE}/process`, body);
    }

    /**
     * List multimodal-capable (vision) models for a provider. Mostly FREE.
     * Endpoint: POST /api/backends/chat-completions/multimodal-models/<provider>
     *
     * Providers (sub-router mounts in chat-completions.js): 'pollinations',
     * 'aimlapi', 'nanogpt', 'electronhub', 'chutes', 'mistral', 'xai',
     * 'moonshot', 'workers_ai'. Key-gated providers answer [] without a key.
     *
     * @param {string} provider sub-route name
     * @param {object} [params]
     * @param {string} [params.workersAiAccountId] -> workers_ai_account_id (workers_ai only)
     * @returns {Promise<string[]>} model ids (possibly [])
     * @throws {TypeError} client-side when provider is missing
     */
    async multimodalModels(provider, params = {}) {
        requireNonEmpty(provider, 'provider', 'multimodalModels');
        const body = {};
        if (params.workersAiAccountId !== undefined) {
            body.workers_ai_account_id = params.workersAiAccountId; // request.body.workers_ai_account_id
        }
        return await this.client.post(`${CC_BASE}/multimodal-models/${encodeURIComponent(provider)}`, body);
    }

    // ---------------------------------------------------------------- text completions

    /**
     * Text-completion backend status check (model list + first model id).
     * Endpoint: POST /api/backends/text-completions/status
     *
     * Routes per api_type (TEXTGEN_TYPES, src/constants.js): ooba/vllm/
     * aphrodite/koboldcpp/llamacpp/infermaticai/openrouter/featherless/generic
     * -> <base>/v1/models; dreamgen -> /api/openai/v1/models; mancer ->
     * /oai/v1/models; tabby -> /v1/model/list; togetherai -> /api/models?&info;
     * ollama -> /api/tags; huggingface -> /info. 'localhost' in api_server is
     * rewritten to 127.0.0.1 server-side.
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED backend base URL
     * @param {string} [params.apiType] one of TEXTGEN_TYPES values ('ooba',
     *   'koboldcpp', 'llamacpp', 'vllm', 'aphrodite', 'tabby', 'mancer',
     *   'togetherai', 'ollama', 'infermaticai', 'dreamgen', 'openrouter',
     *   'featherless', 'huggingface', 'generic')
     * @param {string} [params.secretId] stored key id for auth headers
     * @param {Record<string, any>} [params.extra] extra wire fields
     * @returns {Promise<{result:string, data:Array}>} result = first model id
     *   (or 'Valid'/'None'); data = raw model array
     * @throws {TypeError} client-side when apiServer is missing/empty
     * @throws {import('../core/client.js').StApiError} 500 when the backend is
     *   unreachable or answers non-OK (plain-text 'Internal Server Error')
     */
    async textCompletionsStatus(params = {}) {
        requireNonEmpty(params?.apiServer, 'apiServer', 'textCompletionsStatus');
        return await this.client.post(`${TC_BASE}/status`, buildTextgenBody(params));
    }

    /**
     * Query backend model properties (chat template, sampler support).
     * Endpoint: POST /api/backends/text-completions/props
     * GETs <base>/props; for api_type='llamacpp' appends ?model=<model>.
     * The server adds chat_template_hash (sha256) to the reply.
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED
     * @param {string} [params.apiType]
     * @param {string} [params.model] llamacpp model name
     * @param {string} [params.secretId]
     * @param {Record<string, any>} [params.extra]
     * @returns {Promise<object>} the backend's /props JSON + chat_template_hash
     * @throws {TypeError} client-side when apiServer is missing/empty
     * @throws {import('../core/client.js').StApiError} 400 when the raw body
     *   lacks api_server; 500 when the backend is unreachable
     */
    async textCompletionsProps(params = {}) {
        requireNonEmpty(params?.apiServer, 'apiServer', 'textCompletionsProps');
        return await this.client.post(`${TC_BASE}/props`, buildTextgenBody(params));
    }

    /**
     * Generate through a text-completion backend (raw proxy).
     * Endpoint: POST /api/backends/text-completions/generate
     *
     * The handler forwards the WHOLE body to the backend after per-api_type
     * whitelisting (OPENAI_KEYS for 'generic', OLLAMA_KEYS wrapped in
     * {model, prompt, stream, keep_alive, raw, options} for 'ollama',
     * TOGETHERAI_KEYS, INFERMATICAI_KEYS, FEATHERLESS_KEYS, VLLM_KEYS,
     * OPENROUTER_KEYS). Unknown snake_case sampler fields therefore pass
     * through verbatim - send them already in wire format.
     *
     * Routing per api_type: ooba/vllm/featherless/aphrodite/tabby/koboldcpp/
     * togetherai/infermaticai/huggingface/generic -> /v1/completions;
     * dreamgen -> /api/openai/v1/completions; mancer -> /oai/v1/completions;
     * llamacpp -> /completion; ollama -> /api/generate; openrouter ->
     * /v1/chat/completions.
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED
     * @param {string} params.apiType REQUIRED one of TEXTGEN_TYPES values
     * @param {string} params.prompt REQUIRED completion prompt
     * @param {string} [params.model]
     * @param {boolean} [params.stream] true -> raw SSE text is returned
     * @param {string} [params.secretId]
     * @param {Record<string, any>} [params.rest] any backend sampler field in
     *   snake_case (max_tokens, repetition_penalty, temperature, ...)
     * @returns {Promise<any>} non-stream: backend JSON, or on failure
     *   {error:true, status:'ECONNREFUSED'|number, response:string};
     *   stream: raw SSE text
     * @throws {TypeError} client-side when apiServer or prompt is missing
     */
    async textCompletionsGenerate(params = {}) {
        requireNonEmpty(params?.apiServer, 'apiServer', 'textCompletionsGenerate');
        if (params?.prompt === undefined || params?.prompt === null) {
            throw new TypeError("BackendsApi.textCompletionsGenerate: 'prompt' is required");
        }
        const body = buildTextgenBody(params);
        if (body.stream) {
            return await this.client.postRaw(`${TC_BASE}/generate`, body);
        }
        return await this.client.post(`${TC_BASE}/generate`, body);
    }

    /**
     * Pull an Ollama model (long-running).
     * Endpoint: POST /api/backends/text-completions/ollama/download
     * Body: {name, api_server} -> server POSTs {name, stream:false} to
     * <api_server>/api/pull.
     *
     * @param {object} params
     * @param {string} params.name REQUIRED model name to pull
     * @param {string} params.apiServer REQUIRED Ollama base URL
     * @returns {Promise<{ok:true}>}
     * @throws {TypeError} client-side when name/apiServer is missing
     * @throws {import('../core/client.js').StApiError} 400 raw without
     *   name+api_server; 500 on pull failure
     */
    async ollamaDownload(params = {}) {
        requireNonEmpty(params?.name, 'name', 'ollamaDownload');
        requireNonEmpty(params?.apiServer, 'apiServer', 'ollamaDownload');
        return await this.client.post(`${TC_BASE}/ollama/download`, {
            name: params.name,                 // request.body.name
            api_server: params.apiServer,      // request.body.api_server
        });
    }

    /**
     * Caption an image with an Ollama vision model.
     * Endpoint: POST /api/backends/text-completions/ollama/caption-image
     * Body: {server_url, model, prompt, image} -> server POSTs
     * {model, prompt, images:[image], stream:false} to <server_url>/api/generate.
     *
     * @param {object} params
     * @param {string} params.serverUrl REQUIRED Ollama base URL (wire: server_url)
     * @param {string} params.model REQUIRED vision model (e.g. 'llava')
     * @param {string} params.prompt REQUIRED caption instruction
     * @param {string} params.image REQUIRED base64 image (no data: prefix)
     * @returns {Promise<{caption:string}>}
     * @throws {TypeError} client-side when image is missing
     * @throws {import('../core/client.js').StApiError} 400 raw without
     *   server_url+model; 500 on backend failure or an empty caption
     */
    async ollamaCaptionImage(params = {}) {
        if (!params?.image) {
            throw new TypeError("BackendsApi.ollamaCaptionImage: 'image' is required");
        }
        return await this.client.post(`${TC_BASE}/ollama/caption-image`, {
            server_url: params.serverUrl,  // request.body.server_url
            model: params.model,           // request.body.model
            prompt: params.prompt,         // request.body.prompt
            image: params.image,           // request.body.image -> images:[image]
        });
    }

    /**
     * Query llama-server properties.
     * Endpoint: POST /api/backends/text-completions/llamacpp/props
     * Body: {server_url} -> GETs <server_url>/props.
     *
     * @param {object} params
     * @param {string} params.serverUrl REQUIRED llama-server base URL
     * @returns {Promise<object>} the /props JSON
     * @throws {TypeError} client-side when serverUrl is missing
     * @throws {import('../core/client.js').StApiError} 400 raw without
     *   server_url; 500 when unreachable
     */
    async llamacppProps(params = {}) {
        requireNonEmpty(params?.serverUrl, 'serverUrl', 'llamacppProps');
        return await this.client.post(`${TC_BASE}/llamacpp/props`, {
            server_url: params.serverUrl, // request.body.server_url
        });
    }

    /**
     * Manage llama-server context slots.
     * Endpoint: POST /api/backends/text-completions/llamacpp/slots
     * Body: {server_url, action, id_slot?, filename?}. action='info' GETs
     * /slots; erase/save/restore POST /slots/<id_slot>?action=<action> with
     * {filename} (filename required for save/restore).
     *
     * @param {object} params
     * @param {string} params.serverUrl REQUIRED
     * @param {'info'|'erase'|'save'|'restore'} params.action REQUIRED
     * @param {number|string} [params.idSlot] slot id (wire: id_slot; required
     *   for erase/save/restore, must stringify to digits)
     * @param {string} [params.filename] state file name (save/restore)
     * @returns {Promise<any>} slot info or the action reply
     * @throws {TypeError} client-side on a missing/invalid action
     * @throws {import('../core/client.js').StApiError} 400 raw validation
     *   failures; 500 when the backend is unreachable
     */
    async llamacppSlots(params = {}) {
        requireNonEmpty(params?.serverUrl, 'serverUrl', 'llamacppSlots');
        if (!/^(erase|info|restore|save)$/.test(String(params?.action))) {
            throw new TypeError(
                "BackendsApi.llamacppSlots: 'action' must be one of erase|info|restore|save",
            );
        }
        const body = {
            server_url: params.serverUrl, // request.body.server_url
            action: params.action,        // request.body.action (regex-validated server-side too)
        };
        if (params.idSlot !== undefined) body.id_slot = params.idSlot;     // request.body.id_slot
        if (params.filename !== undefined) body.filename = params.filename; // request.body.filename
        return await this.client.post(`${TC_BASE}/llamacpp/slots`, body);
    }

    /**
     * Download a model through TabbyAPI (requires an ADMIN key).
     * Endpoint: POST /api/backends/text-completions/tabby/download
     * The handler first checks <base>/v1/auth/permission (403 unless 'admin'),
     * then POSTs the whole body to <base>/v1/download. Extra TabbyAPI fields
     * (e.g. the repo id) pass through verbatim.
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED TabbyAPI base URL
     * @param {string} [params.apiType] should be 'tabby' (auth-header lookup)
     * @param {string} [params.secretId] stored TabbyAPI key id
     * @param {Record<string, any>} [params.extra] TabbyAPI download fields
     * @returns {Promise<{ok:true}>}
     * @throws {TypeError} client-side when apiServer is missing
     * @throws {import('../core/client.js').StApiError} 403 without admin
     *   permission; 500 on download failure
     */
    async tabbyDownload(params = {}) {
        requireNonEmpty(params?.apiServer, 'apiServer', 'tabbyDownload');
        return await this.client.post(`${TC_BASE}/tabby/download`, buildTextgenBody(params));
    }

    // ---------------------------------------------------------------- kobold

    /**
     * KoboldCpp / KoboldAI status.
     * Endpoint: POST /api/backends/kobold/status
     * Probes <base>/v1/info/version, <base>/extra/version and <base>/v1/model
     * in parallel; each failure falls back silently.
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED - a raw request without
     *   api_server CRASHES the ST server (unhandled rejection, verified live)
     * @param {string} [params.apiType] 'koboldcpp' enables the stored-key auth header
     * @param {string} [params.secretId]
     * @returns {Promise<{koboldUnitedVersion:string, koboldCppVersion?:string,
     *   model:string}>} model is 'no_connection' when unreachable. QUIRK:
     *   koboldCppVersion is ABSENT for a dead server (source reads `.result`
     *   off the {version:'0.0'} fallback -> undefined -> dropped from JSON).
     * @throws {TypeError} client-side when apiServer is missing/empty
     */
    async koboldStatus(params = {}) {
        requireNonEmpty(params?.apiServer, 'apiServer', 'koboldStatus');
        return await this.client.post(`${KOBOLD_BASE}/status`, buildKoboldBody(params));
    }

    /**
     * Generate through KoboldCpp/KoboldAI (raw proxy).
     * Endpoint: POST /api/backends/kobold/generate
     * Non-streaming POSTs <base>/v1/generate; streaming=true POSTs
     * <base>/extra/generate/stream and returns raw SSE text. When
     * guiSettings is falsy the handler builds its own settings object from
     * the sampler fields (KOBOLD_FIELD_MAP cites every one).
     *
     * @param {object} params
     * @param {string} params.apiServer REQUIRED (crash guard, see koboldStatus)
     * @param {string} params.prompt REQUIRED
     * @param {number} [params.maxContextLength] wire: max_context_length
     * @param {number} [params.maxLength] wire: max_length
     * @param {boolean} [params.guiSettings] use the backend's own sampler settings
     * @param {number} [params.repPen] repetition penalty
     * @param {number} [params.repPenRange]
     * @param {number} [params.repPenSlope]
     * @param {number} [params.temperature]
     * @param {number} [params.tfs] tail-free sampling
     * @param {number} [params.topA]
     * @param {number} [params.topK]
     * @param {number} [params.topP]
     * @param {number} [params.minP]
     * @param {number} [params.typical]
     * @param {number[]} [params.samplerOrder]
     * @param {boolean} [params.singleline]
     * @param {boolean} [params.useDefaultBadwordsids]
     * @param {number} [params.mirostat]
     * @param {number} [params.mirostatEta]
     * @param {number} [params.mirostatTau]
     * @param {string} [params.grammar]
     * @param {number} [params.samplerSeed]
     * @param {string} [params.stopSequence]
     * @param {boolean} [params.streaming] SSE mode (NOT `stream` - kobold quirk)
     * @param {boolean} [params.canAbort] send /extra/abort on socket close
     * @returns {Promise<any>} non-stream: {results:[{text}]} or on connection
     *   failure {error:true} (200!); stream: raw SSE text
     * @throws {TypeError} client-side when apiServer/prompt is missing or a
     *   parameter is unknown
     * @throws {import('../core/client.js').StApiError} 400 {error:{message}}
     *   when the backend answers non-OK
     */
    async koboldGenerate(params = {}) {
        if (params?.prompt === undefined || params?.prompt === null) {
            throw new TypeError("BackendsApi.koboldGenerate: 'prompt' is required");
        }
        const body = buildKoboldBody(params); // enforces apiServer (crash guard)
        if (body.streaming) {
            return await this.client.postRaw(`${KOBOLD_BASE}/generate`, body);
        }
        return await this.client.post(`${KOBOLD_BASE}/generate`, body);
    }

    /**
     * Compute embeddings through KoboldCpp.
     * Endpoint: POST /api/backends/kobold/embed
     * Body: {server, items} - NOTE the wire field is `server`, NOT api_server
     * (handler: `const { server, items } = request.body`). POSTs {input:items}
     * to <server>/api/extra/embeddings.
     *
     * @param {object} params
     * @param {string} params.server REQUIRED koboldcpp base URL
     * @param {string[]} params.items REQUIRED texts to embed
     * @returns {Promise<{model:string, embeddings:number[][]}>}
     * @throws {TypeError} client-side when server/items is missing
     * @throws {import('../core/client.js').StApiError} 400 raw without server;
     *   500 when unreachable or the reply has no data array
     */
    async koboldEmbed(params = {}) {
        requireNonEmpty(params?.server, 'server', 'koboldEmbed');
        if (!Array.isArray(params?.items)) {
            throw new TypeError("BackendsApi.koboldEmbed: 'items' must be an array of strings");
        }
        return await this.client.post(`${KOBOLD_BASE}/embed`, {
            server: params.server, // request.body.server
            items: params.items,   // request.body.items -> {input: items}
        });
    }

    /**
     * Transcribe audio through KoboldCpp whisper.
     * Endpoint: POST /api/backends/kobold/transcribe-audio
     * Multipart upload (global multer field 'avatar'); the server base64s the
     * file and POSTs {prompt:'', audio_data} to <server>/api/extra/transcribe.
     * Body field: `server` (NOT api_server).
     *
     * @param {Buffer|Uint8Array} audioBuffer audio file bytes (wav)
     * @param {object} params
     * @param {string} params.server REQUIRED koboldcpp base URL
     * @param {string} [params.fileName='audio.wav']
     * @param {string} [params.mimeType='audio/wav']
     * @returns {Promise<any>} the koboldcpp transcription JSON
     * @throws {TypeError} client-side when audioBuffer is not a Buffer or
     *   server is missing
     * @throws {import('../core/client.js').StApiError} 400 raw without server
     *   or file; 500 on backend failure
     */
    async koboldTranscribeAudio(audioBuffer, params = {}) {
        if (!Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
            throw new TypeError('BackendsApi.koboldTranscribeAudio: audioBuffer must be a Buffer');
        }
        requireNonEmpty(params?.server, 'server', 'koboldTranscribeAudio');
        return await this.client.postFormJson(
            `${KOBOLD_BASE}/transcribe-audio`,
            { server: params.server }, // request.body.server
            {
                fieldName: 'avatar', // global multer single('avatar') mount
                fileName: params.fileName ?? 'audio.wav',
                mimeType: params.mimeType ?? 'audio/wav',
                data: audioBuffer,
            },
        );
    }

    // ---------------------------------------------------------------- internal

    /**
     * Validate the chat_completion_source parameter.
     * @param {unknown} source
     * @param {string} where method name for the message
     */
    #assertSource(source, where) {
        if (source === undefined || source === null || !String(source).trim().length) {
            throw new TypeError(`BackendsApi.${where}: 'chatCompletionSource' is required`);
        }
        if (!CHAT_COMPLETION_SOURCES.includes(source)) {
            throw new TypeError(
                `BackendsApi.${where}: unknown chatCompletionSource '${source}'. ` +
                `Valid: ${CHAT_COMPLETION_SOURCES.join(', ')}`,
            );
        }
    }

    /**
     * Validate the common /generate parameters.
     * @param {any} params
     */
    #assertGenerateParams(params) {
        if (!params || typeof params !== 'object') {
            throw new TypeError('BackendsApi.chatCompletionsGenerate: expected an options object');
        }
        this.#assertSource(params.chatCompletionSource, 'chatCompletionsGenerate');
        if (params.messages === undefined || params.messages === null) {
            throw new TypeError("BackendsApi.chatCompletionsGenerate: 'messages' is required (array of {role, content}, or a plain string)");
        }
        if (!params.model) {
            throw new TypeError("BackendsApi.chatCompletionsGenerate: 'model' is required");
        }
    }
}
