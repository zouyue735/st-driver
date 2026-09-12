/**
 * PresetsApi - /api/presets/* endpoints (ST 1.18.0, src/endpoints/presets.js).
 *
 * Manages prompt/sampling preset files across all API sources. Each preset is
 * a single JSON file in the source-specific directory; names are sanitized
 * server-side with sanitize-filename.
 */

/**
 * Every apiId the server's getPresetSettingsByAPI() accepts.
 * Anything else yields HTTP 400 on save/delete.
 */
export const PRESET_API_IDS = Object.freeze([
    'kobold',
    'koboldhorde',
    'novel',
    'textgenerationwebui',
    'openai',
    'instruct',
    'context',
    'sysprompt',
    'reasoning',
]);

export class PresetsApi {
    /** @param {import('../core/client.js').STClient} client connected ST client */
    constructor(client) {
        this.client = client;
    }

    /**
     * POST /api/presets/save - write (create or overwrite) a preset file.
     * @param {object} params
     * @param {string} params.name preset name (file name without extension)
     * @param {object} params.preset full preset object to store as JSON
     * @param {string} params.apiId one of PRESET_API_IDS
     * @returns {Promise<{name: string}>} the sanitized stored name
     */
    async save({ name, preset, apiId }) {
        return await this.client.post('/api/presets/save', { name, preset, apiId });
    }

    /**
     * POST /api/presets/delete - delete a preset file.
     * @param {object} params
     * @param {string} params.name preset name
     * @param {string} params.apiId one of PRESET_API_IDS
     * @returns {Promise<null>} 200 on success; StApiError 404 when the file does not exist
     */
    async delete({ name, apiId }) {
        return await this.client.post('/api/presets/delete', { name, apiId });
    }

    /**
     * POST /api/presets/restore - fetch the factory-default content of a
     * shipped preset (content-manager defaults).
     * @param {object} params
     * @param {string} params.name preset name as shipped, e.g. 'ChatML'
     * @param {string} params.apiId one of PRESET_API_IDS
     * @returns {Promise<{isDefault: boolean, preset: object}>}
     *   isDefault=false and preset={} for names that are not factory defaults
     */
    async restore({ name, apiId }) {
        return await this.client.post('/api/presets/restore', { name, apiId });
    }
}
