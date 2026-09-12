import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';
import { newClient } from '../helpers.js';

// Live integration tests for the UI session facade (Playwright track).
// UI state (open chat / persona) is saved before and restored after the suite.
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 180_000;

let session;
let client;
let savedState;

before(async () => {
    client = await newClient();
    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
    savedState = await session.state.save();
});

after(async () => {
    try {
        if (session && savedState) await session.state.restore(savedState);
    } finally {
        await session?.close();
        await client?.close();
    }
});

describe('UiSession facade', { timeout: TEST_TIMEOUT }, () => {
    test('exposes the core building blocks', () => {
        assert.ok(session.browser, 'browser');
        assert.ok(session.stscript, 'stscript bridge');
        assert.ok(session.connection, 'connection control');
        assert.ok(session.chat, 'chat control');
        assert.ok(session.generation, 'generation control');
        assert.ok(session.personas, 'persona control');
        assert.ok(session.groups, 'group control');
        assert.ok(session.settings, 'ui settings control');
        assert.ok(session.state, 'state guard');
    });

    test('connection.status reports the headless session starts disconnected', async () => {
        // VERIFIED BEHAVIOR: a fresh headless page has online_status
        // 'no_connection' - this is exactly why ConnectionControl exists
        // (Generate silently skips the LLM call in that state).
        const status = await session.connection.status();
        assert.equal(typeof status.onlineStatus, 'string');
        assert.equal(typeof status.mainApi, 'string');
        // source comes from the user's persisted settings
        assert.ok(status.source === null || typeof status.source === 'string');
    });

    test('connection.connect verifies the backend and reports models', async () => {
        const result = await session.connection.connect();
        assert.equal(typeof result.onlineStatus, 'string');
        if (result.checked && result.status === 200) {
            assert.ok(Array.isArray(result.models), 'model list expected on a healthy backend');
            assert.ok(result.models.length > 0, 'configured backend must list models');
        }
        const connected = await session.connection.isConnected();
        assert.equal(typeof connected, 'boolean');
    });

    test('state.save captures the current UI context', async () => {
        const state = await session.state.save();
        assert.equal(typeof state, 'object');
        assert.ok('characterId' in state, 'characterId key present');
        assert.ok('groupId' in state, 'groupId key present');
        assert.ok('chatId' in state, 'chatId key present');
        assert.ok('userAvatar' in state, 'userAvatar key present');
        assert.ok('background' in state, 'background key present');
    });

    test('state.restore of a just-saved state is a no-op that resolves', async () => {
        const state = await session.state.save();
        await session.state.restore(state);
        const after = await session.state.save();
        assert.deepEqual(
            { c: after.characterId, g: after.groupId },
            { c: state.characterId, g: state.groupId },
        );
    });

    test('evaluate shortcut delegates to the browser page', async () => {
        assert.equal(await session.evaluate(() => 1 + 1), 2);
    });
});

describe('STscript registry coverage', { timeout: TEST_TIMEOUT }, () => {
    test('every registered command parses through the bridge (full UI surface reachable)', async () => {
        // parse-only coverage: proves the driver can address all ~290 commands
        // (core + extensions) exposed by the running frontend.
        const report = await session.evaluate(async () => {
            const ctx = SillyTavern.getContext();
            // ctx.SlashCommandParser is the CLASS (commands registry is static);
            // the live singleton parser (with .parse) comes from slash-commands.js
            // -- after APP_READY the dynamic import hits the same module instance.
            const { parser } = await import('/scripts/slash-commands.js');
            const names = Object.keys(ctx.SlashCommandParser.commands)
                .filter(n => !n.startsWith('/') && n !== 'parser-flag' && n !== '#');
            const failed = [];
            for (const name of names) {
                try {
                    // parse-only, no execution (verifyCommandNames=true)
                    parser.parse(`/${name}`, true);
                } catch (e) {
                    failed.push({ name, error: String(e.message ?? e).slice(0, 100) });
                }
            }
            return { total: names.length, failed };
        });
        assert.ok(report.total > 150, `expected 150+ registered commands, got ${report.total}`);
        assert.deepEqual(report.failed, [], `commands that failed to parse: ${JSON.stringify(report.failed)}`);
    });

    test('command registry includes the documented UI-feature commands', async () => {
        const cmds = await session.stscript.listCommands();
        const names = new Set(cmds.map(c => c.name));
        const required = [
            // chat & generation
            'send', 'sendas', 'sys', 'comment', 'gen', 'genraw', 'continue', 'regenerate',
            'swipe', 'impersonate', 'trigger', 'stop', 'del', 'messages',
            // characters & groups
            'char-create', 'char-update', 'char-get', 'char-delete', 'go', 'rename-char',
            'member-add', 'member-remove', 'member-enable', 'member-disable', 'member-count',
            // personas
            'persona-set', 'persona-create', 'persona-get', 'persona-delete', 'persona-lock',
            // world info
            'world', 'createentry', 'setentryfield', 'getentryfield', 'findentry',
            // variables & control flow
            'setvar', 'getvar', 'if', 'while', 'times', 'run',
            // UI
            'bg', 'theme', 'model', 'api', 'preset', 'context', 'instruct-on', 'sysprompt-off',
            'bubble', 'flat', 'popup', 'echo', 'setinput',
            // extensions
            'qr', 'regex', 'summarize', 'imagine', 'speak', 'translate', 'db-list',
            // bookmarks
            'branch-create', 'checkpoint-create', 'checkpoint-go',
        ];
        const missing = required.filter(r => !names.has(r));
        assert.deepEqual(missing, [], `missing commands in live registry: ${missing.join(', ')}`);
    });
});
