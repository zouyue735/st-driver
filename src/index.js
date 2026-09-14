/**
 * st-driver: one entry point for driving a running SillyTavern instance.
 *
 *   const st = await createStDriver();           // HTTP track (fast)
 *   await st.api.characters.all();
 *
 *   const ui = await createUiDriver();           // UI track (Playwright)
 *   await ui.session.generation.sendAndGenerate('hi');
 *
 * API modules are loaded lazily so a missing/unfinished module never breaks
 * the rest of the driver.
 */
import { STClient, StApiError } from './core/client.js';
import { StBrowser, findBrowserExecutable } from './core/browser.js';
import { StscriptBridge } from './core/stscript.js';
import { UiSession } from './ui/session.js';
import { InstanceManager, InstanceError, DEFAULT_INSTANCES, LOG_DIR } from './core/instance.js';

export {
    STClient, StApiError, StBrowser, StscriptBridge, UiSession, findBrowserExecutable,
    InstanceManager, InstanceError, DEFAULT_INSTANCES, LOG_DIR,
};

/** Registry of API modules: property name on `st.api` -> module path + export name. */
const API_MODULES = {
    characters: { path: './api/characters.js', export: 'CharactersApi' },
    chats: { path: './api/chats.js', export: 'ChatsApi' },
    groups: { path: './api/groups.js', export: 'GroupsApi' },
    worldinfo: { path: './api/worldinfo.js', export: 'WorldInfoApi' },
    settings: { path: './api/settings.js', export: 'SettingsApi' },
    presets: { path: './api/presets.js', export: 'PresetsApi' },
    secrets: { path: './api/secrets.js', export: 'SecretsApi' },
    tokenizers: { path: './api/tokenizers.js', export: 'TokenizersApi' },
    personas: { path: './api/personas.js', export: 'PersonasApi' },
    backgrounds: { path: './api/backgrounds.js', export: 'BackgroundsApi' },
    uipresets: { path: './api/uipresets.js', export: null }, // ThemesApi / MovingUiApi / QuickRepliesApi
    sprites: { path: './api/sprites.js', export: 'SpritesApi' },
    media: { path: './api/media.js', export: null }, // FilesApi / ImagesApi / ImageMetadataApi / AssetsApi
    maintenance: { path: './api/maintenance.js', export: null }, // StatsApi / BackupsApi / DataMaidApi
    extensions: { path: './api/extensions.js', export: 'ExtensionsApi' },
    vectors: { path: './api/vectors.js', export: 'VectorsApi' },
    externalAi: { path: './api/external-ai.js', export: null }, // TranslateApi / CaptionApi / ClassifyApi / SpeechApi
    sd: { path: './api/sd.js', export: 'StableDiffusionApi' },
    search: { path: './api/search.js', export: null }, // SearchApi / HordeApi
    backends: { path: './api/backends.js', export: 'BackendsApi' },
    content: { path: './api/content.js', export: 'ContentApi' },
};

/**
 * Create the HTTP-track driver: a connected STClient with lazily-loaded API
 * modules under `.api`.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl='http://localhost:8000']
 * @param {number} [options.timeout=120000]
 * @returns {Promise<{client: STClient, api: object, close: ()=>Promise<void>}>}
 */
export async function createStDriver(options = {}) {
    const client = new STClient(options);
    await client.connect();

    /** Populated by loadApi/loadAll: module name -> instantiated API object. */
    const api = {};

    /**
     * Asynchronously load one API module (cached on `api`).
     * @param {string} name key of API_MODULES
     * @returns {Promise<any>} instantiated API class (or module namespace for multi-export modules)
     */
    async function loadApi(name) {
        if (api[name]) return api[name];
        const spec = API_MODULES[name];
        if (!spec) throw new Error(`unknown api module: ${name} (known: ${Object.keys(API_MODULES).join(', ')})`);
        const mod = await import(spec.path);
        if (spec.export) {
            const Cls = mod[spec.export];
            if (!Cls) throw new Error(`module ${spec.path} does not export ${spec.export}`);
            api[name] = new Cls(client);
        } else {
            api[name] = mod; // namespace with multiple classes
        }
        return api[name];
    }

    /** Load every available API module; missing files are skipped and reported. */
    async function loadAll() {
        const missing = [];
        for (const name of Object.keys(API_MODULES)) {
            try {
                await loadApi(name);
            } catch (e) {
                if (String(e?.message).includes('Cannot find') || e?.code === 'ERR_MODULE_NOT_FOUND') {
                    missing.push(name);
                } else {
                    throw e;
                }
            }
        }
        return { loaded: Object.keys(api), missing };
    }

    return {
        client,
        api,
        loadApi,
        loadAll,
        close: () => client.close(),
    };
}

/**
 * Create the UI-track driver: a launched UiSession (Playwright + ST frontend).
 * @param {object} [options]
 * @param {string} [options.baseUrl='http://localhost:8000']
 * @param {boolean} [options.headless=true]
 * @param {string} [options.executablePath]
 * @param {number} [options.timeout=120000] launch timeout
 * @returns {Promise<{session: UiSession, close: ()=>Promise<void>}>}
 */
export async function createUiDriver(options = {}) {
    const { timeout = 120_000, ...sessionOptions } = options;
    const session = new UiSession(sessionOptions);
    await session.launch({ timeout });
    return {
        session,
        close: () => session.close(),
    };
}
