/**
 * Shared helpers for live integration tests against a running SillyTavern.
 *
 * Conventions:
 * - Every fixture name is prefixed with `__drvtest_` so it is trivially
 *   identifiable and cleanable, even when a test crashes mid-run.
 * - Tests clean up after themselves in `after`/`finally` blocks.
 * - The server URL comes from ST_URL (default http://localhost:8000).
 */
import { STClient } from '../src/core/client.js';

export const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
export const FIXTURE_PREFIX = '__drvtest_';

/** A unique fixture name: __drvtest_<scope>_<timestamp>_<random> */
export function fixtureName(scope = 'x') {
    return `${FIXTURE_PREFIX}${scope}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a connected STClient (call connect() before use). */
export async function newClient() {
    const client = new STClient({ baseUrl: BASE_URL });
    await client.connect();
    return client;
}

/** Minimal 1x1 transparent PNG bytes (valid image for upload tests). */
export function tinyPng() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
}

/** Whether expensive LLM-backed generation tests should run (opt-in). */
export const LIVE_GEN = process.env.ST_DRIVER_LIVE_GEN === '1';

/** Whether tests may make real outbound network calls (opt-in). */
export const LIVE_NET = process.env.ST_DRIVER_LIVE_NET === '1';

/**
 * Retry a flaky-by-nature operation (real-LLM generation) a few times.
 *
 * Why this exists: deepseek occasionally answers a non-streaming chat completion
 * with `content: ''` + `finish_reason: 'stop'` (all output went into
 * reasoning_content), and long non-streaming requests sometimes die with a
 * socket AbortError (logged as "Error communicating with DeepSeek API"). Both
 * are provider-side transients: the SAME driver code passed the same tests on
 * immediate reruns (3x green after one red regression run, with the empty
 * response captured in the ST log as evidence). The driver is REQUIRED to
 * surface these as ok:false / empty text (behavior #17), so the tests must not
 * treat a transient empty reply as a driver defect.
 *
 * Only use for live-generation assertions - never for deterministic API tests,
 * where a failure is a real bug.
 *
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.attempts=3]
 * @param {(error:unknown, attempt:number) => boolean} [options.shouldRetry]
 *   decides whether a rejection is retryable (default: retry everything)
 * @returns {Promise<T>}
 */
/**
 * Decide whether a live-generation assertion failure is a TRANSIENT provider
 * problem (retryable) rather than a driver defect (must fail loudly).
 *
 * Retryable signatures, all observed in the ST log during a real red run:
 *   - `generation not ok` / `settledEmpty=true` / `lastMes=""` — deepseek
 *     answered with empty `content` (output went to reasoning_content) or the
 *     socket aborted mid-request.
 *   - `gen must return generated text` — /gen's catch swallowed an AbortError
 *     and returned ''.
 * Anything else (e.g. "the user message must be persisted", "expected X to
 * reply") is a structural assertion: a real bug that must NOT be retried away.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientGenFailure(error) {
    const msg = String(error?.message ?? error);
    return /generation not ok|settledEmpty=true|lastMes=""|gen must return generated text|AbortError|operation was aborted/i.test(msg);
}

export async function withLiveGenRetry(fn, { attempts = 3, shouldRetry = isTransientGenFailure } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (attempt === attempts || !shouldRetry(e, attempt)) throw e;
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    throw lastError;
}

/**
 * Resolve the on-disk user-data directory of the ST instance under test.
 *
 * A few tests assert server-side quirks at the FILESYSTEM level (e.g. "images/list
 * creates the folder on disk", "moving-ui has no delete endpoint so the fixture
 * file must be swept manually"). Those assertions only make sense when the test
 * process can see the same data directory the server uses - which cannot be
 * derived from ST_URL alone.
 *
 * Therefore filesystem assertions are OPT-IN: set ST_DATA_ROOT to the instance's
 * `data/default-user` directory. When it is unset, `dataRoot()` returns null and
 * the affected assertions/tests skip themselves. Nothing is ever hardcoded to a
 * particular installation path.
 *
 * @returns {string|null} absolute path, or null when not configured
 */
export function dataRoot() {
    const root = process.env.ST_DATA_ROOT;
    if (!root) return null;
    return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Remove every fixture (character/group/world/chat/persona/preset/secret...)
 * whose name starts with the fixture prefix. Used as a final safety net.
 * @param {STClient} client
 */
export async function purgeFixtures(client) {
    const results = { characters: [], groups: [], worlds: [], presets: [], secrets: [], backgrounds: [], avatars: [] };

    // characters
    try {
        const chars = await client.post('/api/characters/all', {});
        for (const c of chars ?? []) {
            if (String(c.name ?? '').startsWith(FIXTURE_PREFIX) || String(c.avatar ?? '').startsWith(FIXTURE_PREFIX)) {
                await client.post('/api/characters/delete', { avatar_url: c.avatar, delete_chats: true }).catch(() => {});
                results.characters.push(c.avatar);
            }
        }
    } catch { /* ignore */ }

    // groups
    try {
        const groups = await client.post('/api/groups/all', {});
        for (const g of groups ?? []) {
            if (String(g.name ?? '').startsWith(FIXTURE_PREFIX)) {
                await client.post('/api/groups/delete', { id: g.id }).catch(() => {});
                results.groups.push(g.name);
            }
        }
    } catch { /* ignore */ }

    // world info
    try {
        const worlds = await client.post('/api/worldinfo/list', {});
        for (const w of worlds ?? []) {
            if (String(w.name ?? '').startsWith(FIXTURE_PREFIX)) {
                await client.post('/api/worldinfo/delete', { name: w.name }).catch(() => {});
                results.worlds.push(w.name);
            }
        }
    } catch { /* ignore */ }

    // backgrounds
    try {
        const { images } = await client.post('/api/backgrounds/all', {});
        for (const img of images ?? []) {
            if (String(img.filename ?? '').startsWith(FIXTURE_PREFIX)) {
                await client.post('/api/backgrounds/delete', { bg: img.filename }).catch(() => {});
                results.backgrounds.push(img.filename);
            }
        }
    } catch { /* ignore */ }

    // personas (user avatars)
    try {
        const avatars = await client.post('/api/avatars/get', {});
        for (const a of avatars ?? []) {
            if (String(a).startsWith(FIXTURE_PREFIX)) {
                await client.post('/api/avatars/delete', { avatar: a }).catch(() => {});
                results.avatars.push(a);
            }
        }
    } catch { /* ignore */ }

    return results;
}
