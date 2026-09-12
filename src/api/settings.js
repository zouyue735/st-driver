/**
 * SettingsApi - /api/settings/* endpoints (ST 1.18.0, src/endpoints/settings.js).
 *
 * Covers reading the settings envelope, whole-file overwrites, and the
 * snapshot (backup) endpoints. Note: the server has NO snapshot-delete
 * endpoint - snapshots created via makeSnapshot() persist in the user's
 * backups directory and are rotated out by ST's own removeOldBackups().
 */

/**
 * @typedef {object} SettingsSnapshot
 * @property {number} date snapshot ctime in ms
 * @property {string} name file name, e.g. settings_default-user_20260911-001528.json
 * @property {number} size file size in bytes
 */

/**
 * @typedef {object} SettingsEnvelope
 * @property {string} settings raw settings.json content - a JSON STRING, use JSON.parse
 * @property {Array<object>} koboldai_settings
 * @property {string[]} koboldai_setting_names
 * @property {Array<object>} novelai_settings
 * @property {string[]} novelai_setting_names
 * @property {Array<object>} openai_settings
 * @property {string[]} openai_setting_names
 * @property {Array<object>} textgenerationwebui_presets
 * @property {string[]} textgenerationwebui_preset_names
 * @property {string[]} world_names
 * @property {Array<object>} themes
 * @property {Array<object>} movingUIPresets
 * @property {Array<object>} quickReplyPresets
 * @property {Array<object>} instruct
 * @property {Array<object>} context
 * @property {Array<object>} sysprompt
 * @property {Array<object>} reasoning
 * @property {boolean} enable_extensions
 * @property {boolean} enable_extensions_auto_update
 * @property {boolean} enable_accounts
 * @property {{enabled:boolean, minPayloadSize:number, maxPayloadSize:number, timeout:number}} request_compression
 */

export class SettingsApi {
    /** @param {import('../core/client.js').STClient} client connected ST client */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/settings/get - fetch the full settings envelope.
     * The `settings` field is a JSON string; use getSettings() for the parsed object.
     * @returns {Promise<SettingsEnvelope>}
     */
    async get() {
        return await this.client.post('/api/settings/get', {});
    }

    /**
     * Convenience: fetch the envelope and JSON.parse the `settings` field.
     * @returns {Promise<object>} parsed settings.json content
     */
    async getSettings() {
        const envelope = await this.get();
        return JSON.parse(envelope.settings);
    }

    /**
     * POST /api/settings/save - overwrite settings.json entirely.
     * The server writes JSON.stringify(body, null, 4) to disk, so always pass a
     * COMPLETE settings object (e.g. getSettings() + your edits).
     * @param {object} settingsObject full settings object to persist
     * @returns {Promise<{result:'ok'}>}
     */
    async save(settingsObject) {
        return await this.client.post('/api/settings/save', settingsObject);
    }

    /**
     * POST /api/settings/get-snapshots - list settings backups for this user.
     * @returns {Promise<SettingsSnapshot[]>}
     */
    async getSnapshots() {
        return await this.client.post('/api/settings/get-snapshots', {});
    }

    /**
     * POST /api/settings/make-snapshot - force a settings.json backup now.
     * Server answers 204 with an empty body.
     * @returns {Promise<null>}
     */
    async makeSnapshot() {
        return await this.client.post('/api/settings/make-snapshot', {});
    }

    /**
     * POST /api/settings/load-snapshot - read a snapshot's raw content.
     * The name must start with the server-side user prefix
     * (settings_<handle>_), otherwise the server answers 400.
     * @param {{name: string}} params snapshot file name
     * @returns {Promise<string>} raw settings JSON text of the snapshot
     */
    async loadSnapshot({ name }) {
        return await this.client.postRaw('/api/settings/load-snapshot', { name });
    }

    /**
     * POST /api/settings/restore-snapshot - replace settings.json with a snapshot.
     * DESTRUCTIVE for unsaved current state; the name must carry the user prefix.
     * Server answers 204 with an empty body.
     * @param {{name: string}} params snapshot file name
     * @returns {Promise<null>}
     */
    async restoreSnapshot({ name }) {
        return await this.client.post('/api/settings/restore-snapshot', { name });
    }
}
