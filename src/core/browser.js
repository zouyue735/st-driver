/**
 * Browser session against the SillyTavern frontend.
 *
 * SillyTavern's UI-only capabilities (generation pipeline, STscript, personas,
 * swipes, events) live in the browser; this class launches a Chromium-family
 * browser via playwright-core (system Edge/Chrome, no bundled download),
 * waits for APP_READY, and exposes page.evaluate-style helpers.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

/** Ordered list of browser executables to try when no channel/executablePath is given. */
const DEFAULT_EXECUTABLES = [
    process.env.ST_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** Pick the first existing browser executable. @returns {string|null} */
export function findBrowserExecutable() {
    for (const candidate of DEFAULT_EXECUTABLES) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* keep probing */ }
    }
    return null;
}

export class StBrowser {
    /**
     * @param {object} [options]
     * @param {string} [options.baseUrl='http://localhost:8000']
     * @param {boolean} [options.headless=true]
     * @param {string} [options.executablePath] override browser executable
     * @param {{width:number,height:number}} [options.viewport]
     */
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl ?? 'http://localhost:8000').replace(/\/+$/, '');
        this.headless = options.headless ?? true;
        this.executablePath = options.executablePath ?? null;
        this.viewport = options.viewport ?? { width: 1440, height: 900 };
        /** @type {import('playwright-core').Browser|null} */
        this.browser = null;
        /** @type {import('playwright-core').Page|null} */
        this.page = null;
        /** @type {Promise<void>|null} */
        this.readyPromise = null;
    }

    /**
     * Launch the browser, open ST, and wait until SillyTavern.getContext() exists.
     * @param {object} [options]
     * @param {number} [options.timeout=120000] ms to wait for app readiness
     * @returns {Promise<void>}
     */
    async launch(options = {}) {
        const timeout = options.timeout ?? 120_000;
        const executablePath = this.executablePath ?? findBrowserExecutable();
        const launchOptions = { headless: this.headless };
        if (executablePath) launchOptions.executablePath = executablePath;

        this.browser = await chromium.launch(launchOptions);
        const context = await this.browser.newContext({ viewport: this.viewport });
        this.page = await context.newPage();
        // Keep a clean console; ST is chatty. Errors still surface via evaluate.
        await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout });
        await this.waitForReady(timeout);
    }

    /**
     * Wait until the frontend finished full initialization (APP_READY).
     *
     * window.SillyTavern.getContext() exists as soon as script.js loads, but
     * slash commands, settings, characters and extensions are initialized
     * asynchronously afterwards. APP_READY is replayed to late listeners by
     * ST's EventEmitter, so this is safe whether we're early or late.
     * @param {number} timeout ms
     * @returns {Promise<void>}
     */
    async waitForReady(timeout) {
        await this.page.waitForFunction(
            () => typeof window.SillyTavern?.getContext === 'function',
            { timeout, polling: 100 },
        );
        await this.page.evaluate(async () => {
            await new Promise((resolve) => {
                const ctx = SillyTavern.getContext();
                ctx.eventSource.once(ctx.eventTypes.APP_READY, () => resolve());
            });
        });
        // Let extensions and event replay settle after APP_READY.
        await this.page.waitForTimeout(500);
        this.readyPromise = Promise.resolve();
    }

    /**
     * Dismiss any blocking popups (first-run dialogs, confirmations).
     * Best-effort: clicks the OK button of visible popups, presses Escape.
     * @returns {Promise<void>}
     */
    async closePopups() {
        try {
            await this.page.keyboard.press('Escape');
            const okButton = this.page.locator('#dialogue_popup_ok:visible, .popup-button-ok:visible').first();
            if (await okButton.count().catch(() => 0)) {
                await okButton.click({ timeout: 2000 }).catch(() => {});
            }
        } catch { /* best effort */ }
    }

    /**
     * Evaluate a function in the page context.
     * @template T
     * @param {(arg:any)=>T|Promise<T>} fn must be serializable (no closures over Node scope)
     * @param {any} [arg] serializable argument
     * @returns {Promise<T>}
     */
    async evaluate(fn, arg) {
        if (!this.page) throw new Error('StBrowser: call launch() first');
        return await this.page.evaluate(fn, arg);
    }

    /**
     * Evaluate with no Playwright-side timeout (for long generations).
     * @template T
     * @param {(arg:any)=>T|Promise<T>} fn
     * @param {any} [arg]
     * @returns {Promise<T>}
     */
    async evaluateNoTimeout(fn, arg) {
        if (!this.page) throw new Error('StBrowser: call launch() first');
        return await this.page.evaluate(fn, arg);
    }

    /** @returns {Promise<boolean>} whether a generation is currently running */
    async isGenerating() {
        return await this.evaluate(async () => {
            try {
                const { isGenerating } = await import('/script.js');
                return isGenerating();
            } catch {
                const stop = document.querySelector('#mes_stop');
                return !!stop && stop.offsetParent !== null;
            }
        });
    }

    /**
     * Wait until no generation is in flight.
     * @param {number} [timeout=600000] ms
     * @returns {Promise<void>}
     */
    async waitForIdle(timeout = 600_000) {
        await this.page.waitForFunction(
            async () => {
                try {
                    const { isGenerating } = await import('/script.js');
                    return !isGenerating();
                } catch {
                    const stop = document.querySelector('#mes_stop');
                    return !stop || stop.offsetParent === null;
                }
            },
            { timeout, polling: 300 },
        );
    }

    /** Close browser and release resources. */
    async close() {
        try {
            await this.browser?.close();
        } catch { /* already gone */ }
        this.browser = null;
        this.page = null;
    }
}
