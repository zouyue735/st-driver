/**
 * HTTP client for the SillyTavern server API.
 *
 * Auth model (verified against ST 1.18.0 source, src/server-main.js):
 *   1. GET /csrf-token          -> { token } + Set-Cookie session cookie
 *   2. every state-changing POST carries `X-CSRF-Token` header + session cookie
 *
 * All business endpoints are POST with a JSON body; multipart uploads always
 * use the file field name `avatar` (global multer single('avatar') mount).
 */

/** Error thrown for any non-2xx HTTP response from the ST server. */
export class StApiError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} path requested path
     * @param {string|object} body raw or parsed response body
     */
    constructor(status, path, body) {
        const preview = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
        super(`ST API ${status} on ${path}: ${preview}`);
        this.name = 'StApiError';
        this.status = status;
        this.path = path;
        this.body = body;
    }
}

export class STClient {
    /**
     * @param {object} [options]
     * @param {string} [options.baseUrl='http://localhost:8000'] server origin, no trailing slash
     * @param {number} [options.timeout=120000] per-request timeout in ms
     */
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl ?? 'http://localhost:8000').replace(/\/+$/, '');
        this.timeout = options.timeout ?? 120000;
        /** @type {string|null} */
        this.csrfToken = null;
        /** @type {Map<string,string>} cookie name -> value */
        this.cookies = new Map();
    }

    /**
     * Perform the CSRF handshake: GET /csrf-token, capture session cookie(s).
     * Idempotent; safe to call again to refresh the token.
     * @returns {Promise<string>} the CSRF token
     */
    async connect() {
        const res = await this.#fetch('/csrf-token', { method: 'GET' });
        this.#absorbCookies(res);
        if (!res.ok) {
            throw new StApiError(res.status, '/csrf-token', await res.text().catch(() => ''));
        }
        const payload = await res.json();
        this.csrfToken = payload.token;
        if (!this.csrfToken) {
            throw new StApiError(res.status, '/csrf-token', 'server returned no token');
        }
        return this.csrfToken;
    }

    /** Close any lingering resources (fetch has none; kept for symmetry). */
    async close() {
        // nothing to dispose
    }

    /**
     * POST a JSON body and parse the JSON response.
     * @param {string} path e.g. '/api/characters/all'
     * @param {object|Array} [body] JSON-serializable request body
     * @returns {Promise<any>} parsed JSON response
     */
    async post(path, body = {}) {
        const res = await this.#fetch(path, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
        });
        return this.#consume(path, res, 'json');
    }

    /**
     * POST a JSON body and return the raw response text (for endpoints that
     * answer with plain text, e.g. /api/characters/create, /api/translate/*).
     * @param {string} path
     * @param {object|Array} [body]
     * @returns {Promise<string>}
     */
    async postRaw(path, body = {}) {
        const res = await this.#fetch(path, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
        });
        return this.#consume(path, res, 'text');
    }

    /**
     * POST JSON and receive a binary response (file downloads, TTS audio).
     * @param {string} path
     * @param {object|Array} [body]
     * @returns {Promise<Buffer>}
     */
    async postBinary(path, body = {}) {
        const res = await this.#fetch(path, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
        });
        return this.#consume(path, res, 'buffer');
    }

    /**
     * POST JSON and return the FULL response (status, headers, binary body).
     * Needed by endpoints whose semantics live in response headers, e.g.
     * /api/content/importURL sets X-Custom-Content-Type: character|lorebook.
     * @param {string} path
     * @param {object|Array} [body]
     * @returns {Promise<{status:number, ok:boolean, headers:Record<string,string>, buffer:Buffer}>}
     *   headers keys are lower-cased; throws StApiError on a non-2xx response
     */
    async postWithResponse(path, body = {}) {
        const res = await this.#fetch(path, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
        });
        this.#absorbCookies(res);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new StApiError(res.status, path, text);
        }
        const headers = {};
        res.headers.forEach((value, key) => { headers[key] = value; });
        return {
            status: res.status,
            ok: res.ok,
            headers,
            buffer: Buffer.from(await res.arrayBuffer()),
        };
    }

    /**
     * GET a path and return the raw response text.
     * @param {string} path may include a query string
     * @returns {Promise<string>}
     */
    async getRaw(path) {
        const res = await this.#fetch(path, { method: 'GET' });
        return this.#consume(path, res, 'text');
    }

    /**
     * GET a path and return the binary response (e.g. /api/sprites/get, thumbnails).
     * @param {string} path may include a query string
     * @returns {Promise<Buffer>}
     */
    async getBinary(path) {
        const res = await this.#fetch(path, { method: 'GET' });
        return this.#consume(path, res, 'buffer');
    }

    /**
     * POST multipart/form-data. The server's global multer mount only accepts
     * the file field name `avatar`.
     * @param {string} path
     * @param {object} [fields] extra form fields (values stringified; arrays/objects become JSON)
     * @param {object} [file]
     * @param {string} [file.fieldName='avatar']
     * @param {string} file.fileName
     * @param {string} [file.mimeType='application/octet-stream']
     * @param {Buffer|Uint8Array|string} file.data
     * @returns {Promise<string>} raw response text (many upload endpoints return plain text)
     */
    async postForm(path, fields = {}, file = null) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null) continue;
            const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
            form.append(key, str);
        }
        if (file) {
            const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : new Uint8Array(file.data);
            form.append(
                file.fieldName ?? 'avatar',
                new Blob([bytes], { type: file.mimeType ?? 'application/octet-stream' }),
                file.fileName,
            );
        }
        const headers = this.buildHeaders({ omitContentType: true });
        const res = await this.#fetch(path, { method: 'POST', headers, body: form });
        return this.#consume(path, res, 'text');
    }

    /**
     * POST multipart/form-data and parse a JSON response.
     * @param {string} path
     * @param {object} [fields]
     * @param {object|null} [file] see postForm
     * @returns {Promise<any>}
     */
    async postFormJson(path, fields = {}, file = null) {
        const text = await this.postForm(path, fields, file);
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    /**
     * Health check: POST /api/ping -> 204.
     * @returns {Promise<boolean>}
     */
    async ping() {
        const res = await this.#fetch('/api/ping', { method: 'POST', headers: this.buildHeaders() });
        return res.ok;
    }

    /**
     * GET /version -> server version payload (no auth required).
     * @returns {Promise<{pkgVersion:string, agent:string, gitRevision:string, gitBranch:string}>}
     */
    async version() {
        const text = await this.getRaw('/version');
        return JSON.parse(text);
    }

    /**
     * Build the JSON request headers, including the CSRF token.
     * @param {object} [options]
     * @param {boolean} [options.omitContentType] for multipart bodies
     * @returns {Record<string,string>}
     */
    buildHeaders({ omitContentType = false } = {}) {
        const headers = {};
        if (!omitContentType) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.csrfToken) {
            headers['X-CSRF-Token'] = this.csrfToken;
        }
        const cookie = this.buildCookieHeader();
        if (cookie) {
            headers['Cookie'] = cookie;
        }
        return headers;
    }

    /**
     * Serialize captured cookies into a Cookie header value.
     * @returns {string}
     */
    buildCookieHeader() {
        return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    #absorbCookies(res) {
        // undici exposes getSetCookie() for multiple Set-Cookie headers
        const setCookies = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter(Boolean);
        for (const raw of setCookies) {
            const pair = raw.split(';')[0];
            const idx = pair.indexOf('=');
            if (idx > 0) {
                this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
            }
        }
    }

    async #fetch(path, init) {
        const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
        return await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(this.timeout),
            redirect: 'follow',
        });
    }

    async #consume(path, res, mode) {
        this.#absorbCookies(res);
        if (!res.ok) {
            let body;
            try {
                body = await res.text();
                const parsed = JSON.parse(body);
                body = parsed;
            } catch {
                // keep as text
            }
            throw new StApiError(res.status, path, body ?? '');
        }
        if (res.status === 204) {
            return mode === 'json' ? null : mode === 'buffer' ? Buffer.alloc(0) : '';
        }
        switch (mode) {
            case 'json': {
                const text = await res.text();
                if (!text) return null;
                try {
                    return JSON.parse(text);
                } catch {
                    return text; // some endpoints answer plain text on success
                }
            }
            case 'buffer':
                return Buffer.from(await res.arrayBuffer());
            default:
                return await res.text();
        }
    }
}
