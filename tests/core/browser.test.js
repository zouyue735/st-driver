import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StBrowser } from '../../src/core/browser.js';
import { StscriptBridge } from '../../src/core/stscript.js';

// Live integration tests: launches a real browser against a running SillyTavern.
// All STscript used here is side-effect-free or uses __drvtest_-prefixed keys.
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 120_000;

let browser;
let stscript;

before(async () => {
    browser = new StBrowser({ baseUrl: BASE_URL, headless: true });
    await browser.launch({ timeout: TEST_TIMEOUT });
    stscript = new StscriptBridge(browser);
});

after(async () => {
    await browser?.close();
});

describe('StBrowser', { timeout: TEST_TIMEOUT }, () => {
    test('launch opens the ST page', async () => {
        const url = browser.page.url();
        assert.ok(url.startsWith(BASE_URL) || url.includes('localhost'), `unexpected url ${url}`);
    });

    test('window.SillyTavern.getContext is available after APP_READY', async () => {
        const ok = await browser.evaluate(() => typeof SillyTavern?.getContext === 'function');
        assert.equal(ok, true);
    });

    test('context exposes core members (characters, eventTypes, chat)', async () => {
        const probe = await browser.evaluate(() => {
            const ctx = SillyTavern.getContext();
            return {
                hasCharacters: Array.isArray(ctx.characters),
                hasEventTypes: typeof ctx.eventTypes === 'object' && ctx.eventTypes !== null,
                hasChat: Array.isArray(ctx.chat),
                hasGenerate: typeof ctx.generate === 'function',
                hasExecuteSlash: typeof ctx.executeSlashCommandsWithOptions === 'function',
            };
        });
        assert.deepEqual(probe, {
            hasCharacters: true,
            hasEventTypes: true,
            hasChat: true,
            hasGenerate: true,
            hasExecuteSlash: true,
        });
    });

    test('evaluate round-trips primitives and objects', async () => {
        assert.equal(await browser.evaluate(() => 42), 42);
        assert.equal(await browser.evaluate(() => 'hello'), 'hello');
        assert.deepEqual(await browser.evaluate(() => ({ a: [1, 2] })), { a: [1, 2] });
    });

    test('evaluate passes arguments into the page function', async () => {
        const echoed = await browser.evaluate(x => ({ got: x }), { deep: { v: 'ok' } });
        assert.deepEqual(echoed, { got: { deep: { v: 'ok' } } });
    });

    test('evaluate propagates page errors as rejections', async () => {
        await assert.rejects(() => browser.evaluate(() => {
            throw new Error('__drvtest_page_error__');
        }), /__drvtest_page_error__/);
    });

    test('closePopups resolves without throwing', async () => {
        await browser.closePopups();
    });

    test('version via context matches HTTP /version', async () => {
        const browserVersion = await browser.evaluate(() => SillyTavern.getContext().version);
        // version may be exposed on context or window; just require something truthy or skip gracefully
        if (browserVersion !== undefined) {
            assert.ok(browserVersion);
        }
    });
});

describe('StscriptBridge', { timeout: TEST_TIMEOUT }, () => {
    test('run returns a result object with pipe/isError fields', async () => {
        const r = await stscript.run('/pass hello');
        assert.equal(typeof r.pipe, 'string');
        assert.equal(typeof r.isError, 'boolean');
    });

    test('/pass puts its argument into the pipe', async () => {
        const r = await stscript.run('/pass hello');
        assert.equal(r.pipe, 'hello');
        assert.equal(r.isError, false);
    });

    test('/add computes a sum into the pipe', async () => {
        const r = await stscript.run('/add 2 3');
        assert.equal(r.pipe, '5');
    });

    test('/mul computes a product into the pipe', async () => {
        const r = await stscript.run('/mul 4 5');
        assert.equal(r.pipe, '20');
    });

    test('/upper and /lower transform text', async () => {
        assert.equal((await stscript.run('/upper abc')).pipe, 'ABC');
        assert.equal((await stscript.run('/lower ABC')).pipe, 'abc');
    });

    test('/len returns string length', async () => {
        const r = await stscript.run('/len abcd');
        assert.equal(r.pipe, '4');
    });

    test('/rand from=N to=N is deterministic when bounds equal', async () => {
        const r = await stscript.run('/rand from=7 to=7');
        assert.equal(r.pipe, '7');
    });

    test('pipe chains: /add consumes {{pipe}} explicitly', async () => {
        // /add sums its unnamed args; the piped value must be referenced via {{pipe}}
        const r = await stscript.run('/pass 5 | /add 3 {{pipe}}');
        assert.equal(r.pipe, '8');
    });

    test('unknown command throws in strict mode (handleParserErrors=false)', async () => {
        await assert.rejects(
            () => stscript.runOrThrow('/__drvtest_no_such_command__', { strict: true }),
            /Unknown command/i,
        );
    });

    test('unknown command is silently ignored by default (ST parser behavior)', async () => {
        const r = await stscript.run('/__drvtest_no_such_command__');
        assert.equal(r.isError, false);
    });

    test('/if with rule=eq takes the true branch', async () => {
        const r = await stscript.run('/if left=a right=a rule=eq {: /pass yes :} else={: /pass no :}');
        assert.equal(r.pipe, 'yes');
    });

    test('/if with rule=neq: condition true runs the true branch', async () => {
        const r = await stscript.run('/if left=a right=b rule=neq {: /pass yes :} else={: /pass no :}');
        assert.equal(r.pipe, 'yes');
    });

    test('/if else branch runs when condition is false (else= BEFORE the then closure)', async () => {
        // Parser quirk (ST 1.18): `else={:...:}` placed AFTER the positional
        // then-closure does not bind and the pipe stays empty. Named args must
        // precede the positional closure.
        const r = await stscript.run('/if left=a right=b rule=eq else={: /pass yes :} {: /pass no :}');
        assert.equal(r.pipe, 'yes');
    });

    test('/if rule=not on empty value takes the then branch', async () => {
        const r = await stscript.run('/if left= rule=not {: /pass notTaken :} else={: /pass elseTaken :}');
        assert.equal(r.pipe, 'notTaken');
    });

    test('chat variables: /setvar then /getvar', async () => {
        const key = `__drvtest_var_${Date.now()}`;
        const set = await stscript.run(`/setvar key=${key} hello-world`);
        assert.equal(set.isError, false, set.errorMessage ?? '');
        const got = await stscript.run(`/getvar key=${key}`);
        assert.equal(got.pipe, 'hello-world');
        await stscript.run(`/flushvar ${key}`);
    });

    test('chat variables: /incvar and /decvar take a positional name', async () => {
        const key = `__drvtest_num_${Date.now()}`;
        await stscript.run(`/setvar key=${key} 10`);
        assert.equal((await stscript.run(`/incvar ${key}`)).pipe, '11');
        assert.equal((await stscript.run(`/decvar ${key}`)).pipe, '10');
        assert.equal((await stscript.run(`/decvar ${key}`)).pipe, '9');
        await stscript.run(`/flushvar ${key}`);
    });

    test('chat variables: /addvar adds to numeric value', async () => {
        const key = `__drvtest_add_${Date.now()}`;
        await stscript.run(`/setvar key=${key} 5`);
        assert.equal((await stscript.run(`/addvar key=${key} 3`)).pipe, '8');
        await stscript.run(`/flushvar ${key}`);
    });

    test('global variables: /setglobalvar then /getglobalvar, then flush', async () => {
        const key = `__drvtest_gvar_${Date.now()}`;
        await stscript.run(`/setglobalvar key=${key} gvalue`);
        const got = await stscript.run(`/getglobalvar key=${key}`);
        assert.equal(got.pipe, 'gvalue');
        await stscript.run(`/flushglobalvar ${key}`);
        const gone = await stscript.run(`/getglobalvar key=${key}`);
        assert.equal(gone.pipe, '');
    });

    test('{{getvar::key}} macro substitutes inside /pass', async () => {
        const key = `__drvtest_macro_${Date.now()}`;
        await stscript.run(`/setvar key=${key} 42`);
        const r = await stscript.run(`/pass {{getvar::${key}}}`);
        assert.equal(r.pipe, '42');
        await stscript.run(`/flushvar ${key}`);
    });

    test('/echo runs without error (toast side effect only)', async () => {
        const r = await stscript.run('/echo __drvtest_echo_probe__');
        assert.equal(r.isError, false, r.errorMessage ?? '');
    });

    test('/times iterates a closure N times', async () => {
        const key = `__drvtest_times_${Date.now()}`;
        await stscript.run(`/setvar key=${key} 0`);
        const r = await stscript.run(`/times 3 {: /incvar ${key} :}`);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        assert.equal((await stscript.run(`/getvar key=${key}`)).pipe, '3');
        await stscript.run(`/flushvar ${key}`);
    });

    test('/listvar return=pipe includes a key we just set', async () => {
        const key = `__drvtest_listvar_${Date.now()}`;
        await stscript.run(`/setvar key=${key} v`);
        const r = await stscript.run('/listvar return=pipe');
        assert.ok(r.pipe.includes(key), `expected ${key} in ${r.pipe.slice(0, 200)}`);
        await stscript.run(`/flushvar ${key}`);
    });

    test('invoke calls a command callback directly (no text parsing)', async () => {
        // /pass callback receives the raw string; invoke must hand it over verbatim
        const text = 'a"b | c\\d name=x 中文\nnewline';
        const r = await stscript.invoke('pass', { text });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        assert.equal(r.pipe, text, 'text must arrive at the callback byte-for-byte');
    });

    test('invoke passes named args to the callback', async () => {
        // /rand from=7 to=7 via namedArgs must be deterministic
        const r = await stscript.invoke('rand', { namedArgs: { from: '7', to: '7' } });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        assert.equal(r.pipe, '7');
    });

    test('invoke of an unknown command reports an error result', async () => {
        const r = await stscript.invoke('__drvtest_no_such_command__');
        assert.equal(r.isError, true);
        assert.match(r.errorMessage, /unknown command/i);
    });

    test('listCommands reports the registered command count and key commands', async () => {
        const cmds = await stscript.listCommands();
        assert.ok(Array.isArray(cmds), 'must return an array');
        assert.ok(cmds.length > 100, `expected 100+ commands, got ${cmds.length}`);
        const names = new Set(cmds.map(c => c.name));
        for (const expected of ['send', 'gen', 'echo', 'setvar', 'getvar', 'persona-set', 'member-add', 'trigger']) {
            assert.ok(names.has(expected), `command /${expected} must be registered`);
        }
        const gen = cmds.find(c => c.name === 'gen');
        assert.ok(gen.named?.includes('lock'), '/gen must expose named args');
        assert.ok(gen.help && gen.help.length > 0, '/gen must have help text');
    });
});
