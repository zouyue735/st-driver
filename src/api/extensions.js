/**
 * Extensions management API wrapper for the SillyTavern server (ST 1.18.0).
 *
 * Routes live under /api/extensions/*. Everything is POST except
 * GET /api/extensions/discover. Verified against the server source
 * (src/endpoints/extensions.js) AND a live server.
 *
 * Layout model:
 * - SYSTEM extensions ship inside the ST installation (public/scripts/extensions)
 *   and are listed by discover() with a bare folder name ('regex', ...).
 * - THIRD-PARTY extensions live in the user's extensions directory (or the
 *   global one, opt-in via {global: true}) and are listed by discover() as
 *   'third-party/<folder>'.
 * - version()/branches()/update()/switch()/move()/delete() resolve
 *   `extensionName` ONLY inside a third-party directory. A system extension
 *   name like 'regex' therefore answers 404 'Directory does not exist at
 *   data\default-user\extensions\regex' - system extensions are NOT
 *   supported by these git-oriented routes (verified live + in source).
 *
 * Live quirks:
 * - All error bodies are PLAIN TEXT (e.g. 'Bad Request: A valid extensionName
 *   is required in the request body.'), not JSON.
 * - A missing extensionName answers 400, but a missing sibling parameter
 *   (branch/source/destination) folds into the same 400 message.
 * - The whole router answers 404 when `extensions.enabled: false` is set in
 *   config.yaml (feature guard in front of every route).
 * - branches() UNSHALLOWS a shallow repo and rewrites the origin fetch refspec
 *   as a side effect; update() runs `git pull`; switch() checks out branches;
 *   move() requires admin and copies+deletes directories. These mutate the
 *   user's install - the live tests for their success paths are skipped.
 * - delete() answers with a plain-text confirmation containing the path.
 * - /install (clone from URL) is deliberately NOT wrapped here: it downloads
 *   and executes third-party code in the user's instance.
 */

const EXT_BASE = '/api/extensions';

/**
 * Wrapper around the SillyTavern extension-management endpoints.
 */
export class ExtensionsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Discover every extension folder known to the server: built-in system
     * extensions, the user's third-party installs and global third-party
     * installs (a global extension shadowed by a same-named user one is
     * omitted).
     * Endpoint: GET /api/extensions/discover (the only GET route here).
     *
     * @returns {Promise<{type: 'system'|'local'|'global', name: string}[]>}
     * system entries carry bare folder names ('regex', 'quick-reply', ...);
     * local/global entries are prefixed with 'third-party/'
     */
    async discover() {
        const text = await this.client.getRaw(`${EXT_BASE}/discover`);
        return JSON.parse(text);
    }

    /**
     * Get git version info for a third-party extension. For a folder that is
     * not a git repository the server answers empty strings with
     * isUpToDate: true instead of failing.
     * Endpoint: POST /api/extensions/version { extensionName, global? }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name (NOT a
     * system extension - those 404)
     * @param {boolean} [params.global=false] look in the global extensions
     * directory instead of the user's
     * @returns {Promise<{currentBranchName: string, currentCommitHash: string,
     * isUpToDate: boolean, remoteUrl: string}>}
     * @throws {import('../core/client.js').StApiError} 400 when extensionName
     * is missing/not a string; 404 when the folder does not exist (incl. any
     * system extension name); 500 on git failures
     */
    async version({ extensionName, global = false } = {}) {
        return await this.client.post(`${EXT_BASE}/version`, { extensionName, global });
    }

    /**
     * List local and remote branches of a third-party extension. Side effect:
     * shallow clones are unshallowed and origin's fetch refspec is widened to
     * all branches (mutates the repo config).
     * Endpoint: POST /api/extensions/branches { extensionName, global? }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name
     * @param {boolean} [params.global=false] use the global directory
     * @returns {Promise<{current: boolean, commit: string, name: string,
     * label: string}[]>} local branches first, then 'origin/*' remotes
     * @throws {import('../core/client.js').StApiError} 400 when extensionName
     * is missing; 403 for a global query without admin rights; 404 when the
     * folder does not exist; 500 when it is not a git repo or git failed
     */
    async branches({ extensionName, global = false } = {}) {
        return await this.client.post(`${EXT_BASE}/branches`, { extensionName, global });
    }

    /**
     * Pull the latest changes for a third-party extension from its origin
     * (no-op when already up to date).
     * Endpoint: POST /api/extensions/update { extensionName, global? }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name
     * @param {boolean} [params.global=false] use the global directory
     * @returns {Promise<{shortCommitHash: string, extensionPath: string,
     * isUpToDate: boolean, remoteUrl: string}>} shortCommitHash is the HEAD
     * commit AFTER the pull, truncated to 7 chars; isUpToDate reflects the
     * state BEFORE pulling
     * @throws {import('../core/client.js').StApiError} 400 when extensionName
     * is missing; 403 for a global update without admin rights; 404 when the
     * folder does not exist; 500 when it is not a git repo or the pull failed
     */
    async update({ extensionName, global = false } = {}) {
        return await this.client.post(`${EXT_BASE}/update`, { extensionName, global });
    }

    /**
     * Check out another branch of a third-party extension. An 'origin/<name>'
     * branch is checked out (creating a local tracking branch when needed);
     * a bare name must already exist locally.
     * Endpoint: POST /api/extensions/switch { extensionName, branch, global? }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name
     * @param {string} params.branch local branch name or 'origin/<branch>'
     * @param {boolean} [params.global=false] use the global directory
     * @returns {Promise<null>} null (the server answers 204 No Content, also
     * when the branch was already checked out)
     * @throws {import('../core/client.js').StApiError} 400 when extensionName
     * or branch is missing; 403 for a global switch without admin rights; 404
     * when the folder or the local branch does not exist; 500 on git failures
     */
    async switch({ extensionName, branch, global = false } = {}) {
        return await this.client.post(`${EXT_BASE}/switch`, { extensionName, branch, global });
    }

    /**
     * Move a third-party extension between the user's and the global
     * extensions directory (admin only; copy + delete of the whole folder).
     * Endpoint: POST /api/extensions/move { extensionName, source, destination }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name
     * @param {'user'|'global'} params.source where the extension lives now
     * (any value other than 'global' means the user directory)
     * @param {'user'|'global'} params.destination where it should live after
     * @returns {Promise<null>} null (the server answers 204 No Content)
     * @throws {import('../core/client.js').StApiError} 400 when any of the
     * three fields is missing; 403 without admin rights; 404 when the source
     * folder does not exist; 409 when the destination already exists or
     * source === destination
     */
    async move({ extensionName, source, destination } = {}) {
        return await this.client.post(`${EXT_BASE}/move`, { extensionName, source, destination });
    }

    /**
     * Delete a third-party extension folder recursively. DESTRUCTIVE.
     * Endpoint: POST /api/extensions/delete { extensionName, global? }.
     *
     * @param {object} params
     * @param {string} params.extensionName third-party folder name
     * @param {boolean} [params.global=false] delete from the global directory
     * @returns {Promise<string>} plain-text confirmation
     * ('Extension has been deleted at <path>')
     * @throws {import('../core/client.js').StApiError} 400 when extensionName
     * is missing; 403 for a global delete without admin rights; 404 when the
     * folder does not exist; 500 when the removal failed
     */
    async delete({ extensionName, global = false } = {}) {
        return await this.client.postRaw(`${EXT_BASE}/delete`, { extensionName, global });
    }
}
