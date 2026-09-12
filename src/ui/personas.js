/**
 * Persona control through the live frontend (/persona-* command callbacks).
 *
 * A persona = an avatar image file + metadata in power_user.personas /
 * persona_descriptions. Avatar file CRUD (upload/delete) is in the HTTP layer
 * (src/api/personas.js); this module handles live selection and metadata,
 * which only the frontend can apply to the running session.
 *
 * All calls go through StscriptBridge.invoke so names/descriptions containing
 * quotes, pipes or `key=`-looking text are passed through verbatim instead of
 * being re-parsed by the STscript parser.
 */
export class PersonaControl {
    /** @param {import('../core/stscript.js').StscriptBridge} stscript */
    constructor(stscript) {
        this.stscript = stscript;
    }

    /**
     * List all personas known to the frontend.
     * Note: since ST ~1.12 the description entry is an object
     * {description, position, depth, role, lorebook, title}, not a plain string.
     * @returns {Promise<Array<{avatarKey:string, name:string, description:any}>>}
     */
    async list() {
        return await this.stscript.browser.evaluate(() => {
            const ctx = SillyTavern.getContext();
            const pu = ctx.powerUserSettings ?? {};
            const names = pu.personas ?? {};
            const descriptions = pu.persona_descriptions ?? {};
            return Object.keys(names).map(avatarKey => ({
                avatarKey,
                name: names[avatarKey] ?? '',
                description: JSON.parse(JSON.stringify(descriptions[avatarKey] ?? '')),
            }));
        });
    }

    /**
     * Get the currently active persona.
     * @returns {Promise<{avatarKey:string|null, name:string|null}>}
     */
    async active() {
        return await this.stscript.browser.evaluate(async () => {
            const personas = await import('/scripts/personas.js');
            const ctx = SillyTavern.getContext();
            const avatarKey = personas.user_avatar || null;
            const names = ctx.powerUserSettings?.personas ?? {};
            return { avatarKey, name: avatarKey ? (names[avatarKey] ?? null) : null };
        });
    }

    /**
     * Switch to an existing persona by name.
     * @param {string} name
     * @param {object} [options]
     * @param {'lookup'|'temp'|'all'} [options.mode] selection mode (default 'all':
     *   use an existing persona, or create a temporary one when none matches)
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async set(name, options = {}) {
        const namedArgs = {};
        if (options.mode) namedArgs.mode = options.mode;
        return await this.stscript.invoke('persona-set', { namedArgs, text: String(name) });
    }

    /**
     * Create a new persona. Returns the avatar key.
     *
     * NOTE (verified in personas.js): `select` defaults to TRUE in the command
     * callback (`!isFalseBoolean(args.select ?? 'true')`), so the new persona
     * becomes active unless select=false is passed explicitly.
     * @param {object} options
     * @param {string} options.name
     * @param {string} [options.description]
     * @param {string} [options.title]
     * @param {boolean} [options.select=true] switch to it immediately
     * @param {0|2|3|4|9} [options.descriptionPosition]
     * @param {number} [options.descriptionDepth]
     * @param {'system'|'user'|'assistant'} [options.descriptionRole]
     * @param {string} [options.lorebook]
     * @returns {Promise<string>} avatar key of the created persona
     */
    async create(options) {
        const namedArgs = { name: String(options.name) };
        if (options.description !== undefined) namedArgs.description = String(options.description);
        if (options.title !== undefined) namedArgs.title = String(options.title);
        // be explicit: the command defaults to selecting the new persona
        namedArgs.select = options.select === false ? 'false' : 'true';
        if (options.descriptionPosition !== undefined) namedArgs.descriptionPosition = String(Number(options.descriptionPosition));
        if (options.descriptionDepth !== undefined) namedArgs.descriptionDepth = String(Number(options.descriptionDepth));
        if (options.descriptionRole !== undefined) namedArgs.descriptionRole = String(options.descriptionRole);
        if (options.lorebook !== undefined) namedArgs.lorebook = String(options.lorebook);
        const r = await this.stscript.invoke('persona-create', { namedArgs });
        if (r.isError) throw new Error(`/persona-create failed: ${r.errorMessage}`);
        if (!r.pipe) throw new Error('/persona-create returned no avatar key (name missing or avatar upload failed)');
        return r.pipe;
    }

    /**
     * Read persona data as JSON (or a single field).
     * @param {object} [options]
     * @param {string} [options.persona] target persona name (default: active)
     * @param {'name'|'description'|'title'|'avatar'|'descriptionPosition'|'descriptionDepth'|'descriptionRole'|'lorebook'} [options.field]
     * @returns {Promise<any>} parsed JSON when no field, else the field value string
     */
    async get(options = {}) {
        const namedArgs = { return: 'pipe' };
        if (options.field) namedArgs.field = options.field;
        if (options.persona) namedArgs.persona = String(options.persona);
        const r = await this.stscript.invoke('persona-get', { namedArgs });
        if (r.isError) throw new Error(`/persona-get failed: ${r.errorMessage}`);
        if (!options.field) {
            try { return JSON.parse(r.pipe); } catch { return r.pipe; }
        }
        return r.pipe;
    }

    /**
     * Update persona fields.
     * @param {object} options
     * @param {string} [options.persona] target persona name (default: active)
     * @param {string} [options.name]
     * @param {string} [options.description]
     * @param {string} [options.title]
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async update(options = {}) {
        const namedArgs = {};
        if (options.persona) namedArgs.persona = String(options.persona);
        if (options.name !== undefined) namedArgs.name = String(options.name);
        if (options.description !== undefined) namedArgs.description = String(options.description);
        if (options.title !== undefined) namedArgs.title = String(options.title);
        return await this.stscript.invoke('persona-update', { namedArgs });
    }

    /**
     * Delete a persona (and its avatar). Irreversible.
     * @param {string} name
     * @param {object} [options]
     * @param {boolean} [options.silent=false] suppress confirmation popup
     * @returns {Promise<import('../core/stscript.js').StscriptResult>} pipe is 'true'/'false'
     */
    async delete(name, options = {}) {
        return await this.stscript.invoke('persona-delete', {
            namedArgs: { persona: String(name), silent: options.silent ? 'true' : 'false' },
        });
    }

    /**
     * Duplicate a persona. Pipe = new avatar key.
     * @param {string} name
     * @param {object} [options]
     * @param {boolean} [options.select=false] switch to the duplicate
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async duplicate(name, options = {}) {
        return await this.stscript.invoke('persona-duplicate', {
            namedArgs: { persona: String(name), select: options.select ? 'true' : 'false' },
        });
    }

    /**
     * Lock the CURRENTLY ACTIVE persona to the current chat / character / as
     * default. (The command has no persona target argument.)
     * @param {object} options
     * @param {'chat'|'character'|'default'} options.type
     * @param {boolean} options.on
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async lock(options) {
        return await this.stscript.invoke('persona-lock', {
            namedArgs: { type: options.type },
            text: options.on ? 'on' : 'off',
        });
    }

    /**
     * Set the persona description injection position/depth/role.
     * @param {object} options
     * @param {0|2|3|4|9} options.position 0=in story string, 2=top AN, 3=bottom AN, 4=at depth, 9=none
     * @param {number} [options.depth] when position=4
     * @param {'system'|'user'|'assistant'} [options.role]
     * @param {string} [options.persona]
     * @returns {Promise<import('../core/stscript.js').StscriptResult>}
     */
    async setDescriptionPlacement(options) {
        const namedArgs = { descriptionPosition: String(Number(options.position)) };
        if (options.persona) namedArgs.persona = String(options.persona);
        if (options.depth !== undefined) namedArgs.descriptionDepth = String(Number(options.depth));
        if (options.role !== undefined) namedArgs.descriptionRole = String(options.role);
        return await this.stscript.invoke('persona-update', { namedArgs });
    }
}
