/**
 * SecretsApi - /api/secrets/* endpoints (ST 1.18.0, src/endpoints/secrets.js).
 *
 * Since ST 1.18, each key can hold MULTIPLE secrets ({id,value,label,active});
 * the newest write becomes the active one, and rotate() switches which entry
 * is active. read() returns masked values unless allowKeysExposure is true in
 * the server config.yaml; find()/view() are additionally gated on that flag,
 * with the exception of the EXPORTABLE_SECRET_KEYS below, which find() will
 * return in clear text regardless.
 */

/**
 * Keys find() is allowed to return in clear text even when
 * allowKeysExposure is false (server EXPORTABLE_KEYS).
 */
export const EXPORTABLE_SECRET_KEYS = Object.freeze([
    'libre_url',
    'lingva_url',
    'oneringtranslator_url',
    'deeplx_url',
]);

/**
 * @typedef {object} SecretState
 * @property {string} id unique id (uuid v4)
 * @property {string} value masked (e.g. "*******abc") unless allowKeysExposure
 * @property {string} label user-facing label
 * @property {boolean} active whether this entry is the one currently in use
 */

export class SecretsApi {
    /** @param {import('../core/client.js').STClient} client connected ST client */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/secrets/write - store a secret. It becomes the active entry
     * for its key; previous entries are deactivated.
     * @param {object} params
     * @param {string} params.key secret key (must be one of the server SECRET_KEYS)
     * @param {string} params.value secret value
     * @param {string} [params.label] display label (server defaults to 'Unlabeled')
     * @returns {Promise<{id: string}>} id of the newly created secret
     */
    async write({ key, value, label }) {
        return await this.client.post('/api/secrets/write', { key, value, label });
    }

    /**
     * POST /api/secrets/read - state map for every known secret key.
     * Unset keys map to null; set keys map to SecretState[] with masked values.
     * @returns {Promise<Record<string, SecretState[]|null>>}
     */
    async read() {
        return await this.client.post('/api/secrets/read', {});
    }

    /**
     * POST /api/secrets/find - fetch a secret value in clear text.
     * Requires allowKeysExposure in config.yaml, EXCEPT for keys listed in
     * EXPORTABLE_SECRET_KEYS (otherwise the server answers 403).
     * @param {object} params
     * @param {string} params.key secret key
     * @param {string} [params.id] specific secret id; omit for the active one
     * @returns {Promise<{value: string}>} 404 when the key holds no secrets
     */
    async find({ key, id }) {
        return await this.client.post('/api/secrets/find', { key, id });
    }

    /**
     * POST /api/secrets/view - all active secrets in clear text (admin view).
     * Requires allowKeysExposure; otherwise 403.
     * @returns {Promise<Record<string, string>>}
     */
    async view() {
        return await this.client.post('/api/secrets/view', {});
    }

    /**
     * POST /api/secrets/delete - remove one secret entry. If no explicit id
     * is given the ACTIVE entry is removed; when the last entry of a key is
     * removed the key disappears from the state map. Server answers 204.
     * @param {object} params
     * @param {string} params.key secret key
     * @param {string} [params.id] secret id; omit for the active one
     * @returns {Promise<null>}
     */
    async delete({ key, id }) {
        return await this.client.post('/api/secrets/delete', { key, id });
    }

    /**
     * POST /api/secrets/rotate - make the secret with the given id the active
     * entry for its key. Unknown ids are a silent no-op (still 204).
     * @param {object} params
     * @param {string} params.key secret key
     * @param {string} params.id secret id to activate
     * @returns {Promise<null>}
     */
    async rotate({ key, id }) {
        return await this.client.post('/api/secrets/rotate', { key, id });
    }

    /**
     * POST /api/secrets/rename - change the label of a secret entry.
     * @param {object} params
     * @param {string} params.key secret key
     * @param {string} params.id secret id
     * @param {string} params.label new label
     * @returns {Promise<null>}
     */
    async rename({ key, id, label }) {
        return await this.client.post('/api/secrets/rename', { key, id, label });
    }

    /**
     * POST /api/secrets/settings - server secrets configuration.
     * @returns {Promise<{allowKeysExposure: boolean}>}
     */
    async settings() {
        return await this.client.post('/api/secrets/settings', {});
    }
}
