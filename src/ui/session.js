/**
 * UiSession - the facade for the browser track of the driver.
 *
 * One UiSession owns one Playwright browser page with SillyTavern open and
 * wires together every UI-side controller:
 *   session.stscript    raw STscript execution (all ~290 slash commands)
 *   session.chat        messages: read / send / inject / delete / swipes
 *   session.generation  the full generation pipeline (prompt assembly + LLM)
 *   session.personas    live persona selection & metadata
 *   session.groups      group chat session control (open / members / trigger)
 *   session.settings    sampling, connection, power-user settings, UI chrome
 *   session.state       save/restore the navigation context (non-destructive runs)
 *
 * Data-plane operations (characters, worlds, files, secrets, ...) belong to
 * the HTTP API modules in src/api/* - use those for CRUD; use this session
 * for anything that requires the live frontend.
 */
import { StBrowser } from '../core/browser.js';
import { StscriptBridge } from '../core/stscript.js';
import { ChatControl } from './chat.js';
import { GenerationControl } from './generation.js';
import { PersonaControl } from './personas.js';
import { GroupControl } from './groups.js';
import { UiSettingsControl } from './settings.js';
import { ConnectionControl } from './connection.js';
import { StateGuard } from './state.js';

export class UiSession {
    /**
     * @param {object} [options]
     * @param {string} [options.baseUrl='http://localhost:8000']
     * @param {boolean} [options.headless=true]
     * @param {string} [options.executablePath] browser executable override
     */
    constructor(options = {}) {
        this.browser = new StBrowser(options);
        this.stscript = new StscriptBridge(this.browser);
        this.connection = new ConnectionControl(this.browser);
        this.chat = new ChatControl(this.browser, this.stscript);
        this.generation = new GenerationControl(this.browser, this.stscript, this.connection);
        this.personas = new PersonaControl(this.stscript);
        this.groups = new GroupControl(this.browser, this.stscript);
        this.settings = new UiSettingsControl(this.browser, this.stscript);
        this.state = new StateGuard(this.browser);
    }

    /**
     * Launch the browser and wait for the app to become ready.
     * @param {object} [options] {timeout}
     * @returns {Promise<void>}
     */
    async launch(options = {}) {
        await this.browser.launch(options);
        await this.browser.closePopups();
    }

    /**
     * Run a non-destructive operation: saves the UI state first and restores
     * it afterwards, even if the operation throws.
     * @template T
     * @param {()=>Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withRestoredState(fn) {
        const saved = await this.state.save();
        try {
            return await fn();
        } finally {
            await this.state.restore(saved).catch(() => {});
        }
    }

    /**
     * Evaluate a function in the page context (shortcut for browser.evaluate).
     * @template T
     * @param {(arg:any)=>T|Promise<T>} fn
     * @param {any} [arg]
     * @returns {Promise<T>}
     */
    async evaluate(fn, arg) {
        return await this.browser.evaluate(fn, arg);
    }

    /** Close the browser session. */
    async close() {
        await this.browser.close();
    }
}
