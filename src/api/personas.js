/**
 * PersonasApi - user personas (avatars) for ST 1.18.0.
 *
 * Two layers:
 *  1. HTTP layer over /api/avatars/* (src/endpoints/avatars.js):
 *       list/upload/delete of PNG files in the user's avatars directory.
 *  2. Settings layer: a persona only exists as far as settings.json knows it:
 *       power_user.personas             {avatarFile -> personaName}
 *       power_user.persona_descriptions {avatarFile -> description}
 *       user_avatar                     currently active persona's avatarFile
 *     The combined operations below (createPersona/updatePersona/
 *     deletePersona/setActivePersona) keep both layers consistent.
 *
 * Also wraps GET /api/users/me (src/endpoints/users-private.js) for account
 * info. In default single-user mode `handle` is 'default-user'.
 *
 * WARNING: the settings-layer methods do read-modify-write of the WHOLE
 * settings.json. Serialize their use against other writers (the ST browser
 * UI also saves settings on changes).
 */
import { SettingsApi } from './settings.js';

/**
 * @typedef {object} Persona
 * @property {string} name persona display name
 * @property {string} avatarFile avatar file name in the avatars directory
 * @property {string} description persona description ('' when unset)
 * @property {boolean} active whether this persona is the current user_avatar
 */

/**
 * @typedef {object} CropParams
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {boolean} [want_resize] resize to the standard avatar size after crop
 */

/**
 * @typedef {object} UserMe
 * @property {string} handle e.g. 'default-user'
 * @property {string} name display name
 * @property {string} avatar data URL or '' (account avatar, not a persona)
 * @property {boolean} admin
 * @property {boolean} password whether a password is set
 * @property {number} created account creation timestamp
 */

export class PersonasApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     * @param {object} [options]
     * @param {SettingsApi} [options.settingsApi] reuse an existing SettingsApi
     */
    constructor(client, options = {}) {
        this.client = client;
        this.settingsApi = options.settingsApi ?? new SettingsApi(client);
    }

    //#region HTTP layer (/api/avatars/*)
    /**
     * POST /api/avatars/get - list every avatar file name.
     * @returns {Promise<string[]>} e.g. ['1787993703209-persona.png', ...]
     */
    async list() {
        return await this.client.post('/api/avatars/get', {});
    }

    /**
     * POST /api/avatars/upload - upload an avatar image (multipart, field 'avatar').
     * @param {Buffer|Uint8Array} buffer PNG/JPEG image bytes
     * @param {object} [options]
     * @param {string} [options.overwriteName] stored file name; when omitted
     *   the server generates '<Date.now()>.png'
     * @param {CropParams} [options.crop] optional crop parameters (sent as
     *   the `crop` query parameter, JSON-encoded by the server's tryParse)
     * @returns {Promise<{path: string}>} stored file name
     */
    async upload(buffer, { overwriteName, crop } = {}) {
        // crop is read from the QUERY string server-side, not the form body
        const query = crop ? `?crop=${encodeURIComponent(JSON.stringify(crop))}` : '';
        const fields = {};
        if (overwriteName) fields.overwrite_name = overwriteName;
        const text = await this.client.postForm(
            `/api/avatars/upload${query}`,
            fields,
            { fieldName: 'avatar', fileName: overwriteName ?? 'avatar.png', mimeType: 'image/png', data: buffer },
        );
        try {
            return JSON.parse(text);
        } catch {
            return { path: text };
        }
    }

    /**
     * POST /api/avatars/delete - remove an avatar file.
     * @param {string} avatar avatar file name (must pass sanitize-filename)
     * @returns {Promise<{result:'ok'}>} 404 when the file does not exist
     */
    async delete(avatar) {
        return await this.client.post('/api/avatars/delete', { avatar });
    }
    //#endregion

    //#region Settings layer helpers
    /**
     * Resolve a persona name to its settings entry.
     * @param {string} name persona display name
     * @returns {Promise<Persona|null>} null when no persona has that name
     */
    async findAvatarByName(name) {
        const settings = await this.settingsApi.getSettings();
        const personas = settings.power_user?.personas ?? {};
        const descriptions = settings.power_user?.persona_descriptions ?? {};
        for (const [avatarFile, personaName] of Object.entries(personas)) {
            if (personaName === name) {
                return {
                    name: personaName,
                    avatarFile,
                    description: descriptions[avatarFile] ?? '',
                    active: settings.user_avatar === avatarFile,
                };
            }
        }
        return null;
    }

    /**
     * List all personas known to settings.json, active flag included.
     * @returns {Promise<Persona[]>}
     */
    async listPersonas() {
        const settings = await this.settingsApi.getSettings();
        const personas = settings.power_user?.personas ?? {};
        const descriptions = settings.power_user?.persona_descriptions ?? {};
        return Object.entries(personas).map(([avatarFile, name]) => ({
            name,
            avatarFile,
            description: descriptions[avatarFile] ?? '',
            active: settings.user_avatar === avatarFile,
        }));
    }

    /**
     * Apply a mutation function to settings.json (read-modify-write) and save.
     * @private
     * @param {(settings: object) => void} mutate in-place mutation
     * @returns {Promise<object>} the saved settings
     */
    async #mutateSettings(mutate) {
        const settings = await this.settingsApi.getSettings();
        settings.power_user ??= {};
        settings.power_user.personas ??= {};
        settings.power_user.persona_descriptions ??= {};
        mutate(settings);
        await this.settingsApi.save(settings);
        return settings;
    }
    //#endregion

    //#region Combined persona operations
    /**
     * Create a persona: upload an avatar (or reuse an existing file), then
     * register name + description in settings.json.
     * @param {object} params
     * @param {string} params.name persona display name (must be unique)
     * @param {string} [params.description=''] persona description
     * @param {Buffer|Uint8Array} [params.avatarBuffer] PNG bytes for a NEW avatar file
     *   (stored as '<name>.png'); mutually exclusive with avatarFile
     * @param {string} [params.avatarFile] attach to an already-uploaded avatar
     *   file instead of uploading one
     * @returns {Promise<Persona>} the created persona
     */
    async createPersona({ name, description = '', avatarBuffer, avatarFile }) {
        if (!name) {
            throw new TypeError('createPersona: name is required');
        }
        if (await this.findAvatarByName(name)) {
            throw new Error(`createPersona: persona "${name}" already exists`);
        }
        let file = avatarFile;
        if (!file) {
            if (!avatarBuffer) {
                throw new TypeError('createPersona: either avatarBuffer or avatarFile is required');
            }
            const uploadName = name.endsWith('.png') ? name : `${name}.png`;
            ({ path: file } = await this.upload(avatarBuffer, { overwriteName: uploadName }));
        }
        await this.#mutateSettings(settings => {
            settings.power_user.personas[file] = name;
            settings.power_user.persona_descriptions[file] = description;
        });
        return { name, avatarFile: file, description, active: false };
    }

    /**
     * Update an existing persona's description and/or name (settings layer only).
     * @param {object} params
     * @param {string} params.name current persona name (lookup key)
     * @param {string} [params.newName] new display name
     * @param {string} [params.description] new description
     * @returns {Promise<Persona>} the updated persona
     */
    async updatePersona({ name, newName, description }) {
        const entry = await this.findAvatarByName(name);
        if (!entry) {
            throw new Error(`updatePersona: persona "${name}" not found`);
        }
        const finalName = newName ?? entry.name;
        const finalDescription = description ?? entry.description;
        await this.#mutateSettings(settings => {
            settings.power_user.personas[entry.avatarFile] = finalName;
            settings.power_user.persona_descriptions[entry.avatarFile] = finalDescription;
        });
        return { ...entry, name: finalName, description: finalDescription };
    }

    /**
     * Delete a persona: remove its settings entries and (by default) the
     * avatar file. If the deleted persona was active, user_avatar is cleared.
     * @param {object} params
     * @param {string} params.name persona display name
     * @param {boolean} [params.deleteAvatar=true] also delete the avatar file
     * @returns {Promise<void>}
     */
    async deletePersona({ name, deleteAvatar = true }) {
        const entry = await this.findAvatarByName(name);
        if (!entry) {
            throw new Error(`deletePersona: persona "${name}" not found`);
        }
        await this.#mutateSettings(settings => {
            delete settings.power_user.personas[entry.avatarFile];
            delete settings.power_user.persona_descriptions[entry.avatarFile];
            if (settings.user_avatar === entry.avatarFile) {
                settings.user_avatar = '';
            }
        });
        if (deleteAvatar) {
            await this.delete(entry.avatarFile).catch(() => { /* file may be gone already */ });
        }
    }

    /**
     * Make a persona the active one by writing settings.user_avatar.
     * @param {string|null} name persona display name, or null to clear
     *   user_avatar (deactivate all personas)
     * @returns {Promise<string>} the avatar file now set as user_avatar ('' when cleared)
     */
    async setActivePersona(name) {
        if (name === null || name === undefined || name === '') {
            await this.#mutateSettings(settings => {
                settings.user_avatar = '';
            });
            return '';
        }
        const entry = await this.findAvatarByName(name);
        if (!entry) {
            throw new Error(`setActivePersona: persona "${name}" not found`);
        }
        await this.#mutateSettings(settings => {
            settings.user_avatar = entry.avatarFile;
        });
        return entry.avatarFile;
    }
    //#endregion

    /**
     * GET /api/users/me - account info for the current session.
     * @returns {Promise<UserMe>}
     */
    async me() {
        const text = await this.client.getRaw('/api/users/me');
        return JSON.parse(text);
    }
}
