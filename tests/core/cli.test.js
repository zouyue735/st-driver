import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI integration tests: spawn `node src/cli.js ...` and assert on stdout/exit.
// Uses only side-effect-free / self-cleaning commands.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'src', 'cli.js');
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';

/**
 * Run the CLI and return {status, stdout, stderr, json} where json is the
 * parsed stdout when it is valid JSON (null otherwise).
 */
function run(args, options = {}) {
    const res = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ST_URL: BASE_URL },
        timeout: options.timeout ?? 60_000,
        // some endpoints (backups list, character dumps) return hundreds of KB;
        // the default 1MB maxBuffer overflows and kills the child with ENOBUFS
        maxBuffer: 64 * 1024 * 1024,
    });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { /* not JSON */ }
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

describe('CLI: help & list', () => {
    test('no args prints usage', () => {
        const r = run([]);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /st-driver CLI/);
        assert.match(r.stdout, /node src\/cli\.js api/);
    });

    test('--help prints usage', () => {
        const r = run(['--help']);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /Usage:/);
    });

    test('list enumerates api and ui tracks as JSON', () => {
        const r = run(['list']);
        assert.equal(r.status, 0);
        assert.ok(r.json, 'list must emit JSON');
        assert.ok(r.json.tracks.api, 'api track listed');
        assert.ok(r.json.tracks.ui, 'ui track listed');
        assert.ok(Array.isArray(r.json.tracks.ui.cliCommands));
    });
});

describe('CLI: raw track', () => {
    test('raw GET /version returns the server version', () => {
        // double-slash avoids MSYS path mangling in shells; CLI also normalizes
        const r = run(['raw', 'GET', '//version']);
        assert.equal(r.status, 0);
        assert.ok(r.json?.pkgVersion, 'pkgVersion present');
    });

    test('raw POST /api/characters/all returns an array', () => {
        const r = run(['raw', 'POST', '//api/characters/all']);
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
    });

    test('raw normalizes a single-slash path (MSYS-mangled input still works)', () => {
        const r = run(['raw', 'GET', '/version']);
        assert.equal(r.status, 0);
        assert.ok(r.json?.pkgVersion);
    });

    test('raw with a bad path exits non-zero with an error object', () => {
        const r = run(['raw', 'POST', '//api/no-such-route']);
        assert.notEqual(r.status, 0);
        assert.ok(r.json?.error, 'error JSON emitted');
    });

    test('raw missing path argument fails with guidance', () => {
        const r = run(['raw', 'GET']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? r.stdout + r.stderr, /method.*path|needs/i);
    });
});

describe('CLI: api track', () => {
    test('api worldinfo.list returns an array', () => {
        const r = run(['api', 'worldinfo.list']);
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
    });

    test('api tokenizers.encode with object args (positional mapping)', () => {
        const r = run(['api', 'tokenizers.encode', '--json', '{"model":"gpt2","text":"hello"}']);
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json?.ids), 'ids array present');
        assert.equal(r.json.count, 1);
    });

    test('api tokenizers.encode with array args (positional form)', () => {
        const r = run(['api', 'tokenizers.encode', '--json', '["gpt2","hello"]']);
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json?.ids));
    });

    test('api groups.all returns an array', () => {
        const r = run(['api', 'groups.all']);
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
    });

    test('api settings.getSettings returns a parsed object', () => {
        const r = run(['api', 'settings.getSettings']);
        assert.equal(r.status, 0);
        assert.equal(typeof r.json, 'object');
        assert.ok('power_user' in r.json || 'oai_settings' in r.json);
    });

    test('api with a dotted-but-unknown method reports available methods', () => {
        const r = run(['api', 'worldinfo.notAMethod']);
        assert.notEqual(r.status, 0);
        assert.ok(r.json?.error);
        assert.ok(Array.isArray(r.json?.available), 'available method list provided');
    });

    test('api positional mapping: object form maps keys onto positional params', () => {
        // worldinfo.get(name) is positional; a missing world answers {entries:{}}
        // at HTTP 200, which proves the name reached the server as a STRING
        // (an object body would not match and would 400 on validation).
        const r = run(['api', 'worldinfo.get', '--json', '{"name":"__drvtest_absent_book__"}']);
        assert.equal(r.status, 0);
        assert.deepEqual(r.json, { entries: {} });
    });

    test('api positional mapping: array form passes explicit positional args', () => {
        const r = run(['api', 'worldinfo.get', '--json', '["__drvtest_absent_book__"]']);
        assert.equal(r.status, 0);
        assert.deepEqual(r.json, { entries: {} });
    });

    test('api positional mapping: multi-param method in declared order', () => {
        // characters.export(avatarUrl, format) - missing avatar -> 404 proves
        // both args landed in the right slots (format alone would not 404)
        const r = run(['api', 'characters.export', '--json', '{"avatarUrl":"__drvtest_missing__.png","format":"json"}']);
        assert.notEqual(r.status, 0);
        assert.equal(r.json?.error?.includes('404') ?? false, true, `expected 404, got ${JSON.stringify(r.json)}`);
    });

    test('api positional mapping: trailing options object is bundled', () => {
        // characters.delete(avatarUrl, {deleteChats}) - the unknown key
        // deleteChats must be bundled into the options argument; a missing
        // avatar answers 400, proving avatarUrl arrived as a plain string.
        const r = run(['api', 'characters.delete', '--json', '{"avatarUrl":"__drvtest_missing__.png","deleteChats":true}']);
        assert.notEqual(r.status, 0);
        assert.equal(r.json?.error?.includes('400') ?? false, true, `expected 400, got ${JSON.stringify(r.json)}`);
    });

    test('api positional mapping: explicit options key is merged too', () => {
        const r = run(['api', 'characters.chats', '--json', '{"avatarUrl":"__drvtest_missing__.png","options":{"simple":true}}']);
        // missing avatar has no chat dir -> {error:true} at HTTP 200
        assert.equal(r.status, 0);
        assert.deepEqual(r.json, { error: true });
    });

    test('api 3-part form resolves a namespace module class (maintenance.StatsApi.get)', () => {
        // maintenance.js exports StatsApi/BackupsApi/DataMaidApi rather than one class
        const r = run(['api', 'maintenance.StatsApi.get']);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(typeof r.json, 'object');
    });

    test('api 3-part form instantiates the class with the shared client', () => {
        const r = run(['api', 'maintenance.BackupsApi.get']);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.ok(Array.isArray(r.json), 'chat backups list expected');
    });

    test('api 3-part form with an unknown class reports the module exports', () => {
        const r = run(['api', 'maintenance.NoSuchApi.doThing']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /is not exported by api module/);
        assert.ok(Array.isArray(r.json?.available));
        assert.ok(r.json.available.includes('StatsApi'));
    });

    test('api without a dot in the target fails with guidance', () => {
        const r = run(['api', 'worldinfo']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /module.*method/i);
    });

    test('api unknown module reports the known list', () => {
        const r = run(['api', 'nope.all']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /unknown api module/);
    });
});

describe('CLI: ui track (headless browser)', { timeout: 180_000 }, () => {
    test('ui stscript evaluates and returns the pipe', () => {
        const r = run(['ui', 'stscript', '--json', '{"script":"/add 40 2"}'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.equal(r.json?.pipe, '42');
        assert.equal(r.json?.isError, false);
    });

    test('ui stscript requires a script argument', () => {
        const r = run(['ui', 'stscript', '--json', '{}'], { timeout: 150_000 });
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /requires/);
    });

    test('ui state returns the navigation context', () => {
        const r = run(['ui', 'state'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.ok('characterId' in r.json);
        assert.ok('userAvatar' in r.json);
    });

    test('ui sampling returns the current sampling parameters', () => {
        const r = run(['ui', 'sampling'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.equal(typeof r.json?.temperature, 'number');
        assert.equal(typeof r.json?.maxTokens, 'number');
    });

    test('ui characters lists index/name/avatar', () => {
        const r = run(['ui', 'characters'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
        if (r.json.length) {
            assert.ok('name' in r.json[0]);
            assert.ok('avatar' in r.json[0]);
        }
    });

    test('ui groups lists groups', () => {
        const r = run(['ui', 'groups'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
    });

    test('ui commands dumps the slash-command registry', () => {
        const r = run(['ui', 'commands'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
        assert.ok(r.json.length > 100, `expected 100+ commands, got ${r.json?.length}`);
        const names = new Set(r.json.map(c => c.name));
        assert.ok(names.has('send') && names.has('gen') && names.has('persona-set'));
    });

    test('ui connection reports the frontend connection state', () => {
        const r = run(['ui', 'connection'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.equal(typeof r.json?.onlineStatus, 'string');
        assert.ok('mainApi' in r.json);
        assert.ok('source' in r.json);
    });

    test('ui connect establishes the API connection for generation', () => {
        const r = run(['ui', 'connect'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        // the user's instance has deepseek configured; the status check should
        // succeed and report models. Tolerate a backend outage (checked:false).
        if (r.json?.connect?.checked && r.json?.connect?.status === 200) {
            assert.ok(Array.isArray(r.json.connect.models), 'model list expected on HTTP 200');
        }
        assert.equal(r.json?.status?.onlineStatus, 'Valid');
    });

    test('ui persona list returns personas', () => {
        const r = run(['ui', 'persona', '--json', '{"action":"list"}'], { timeout: 150_000 });
        assert.equal(r.status, 0);
        assert.ok(Array.isArray(r.json));
    });

    test('ui unknown command lists available commands', () => {
        const r = run(['ui', 'not-a-command'], { timeout: 150_000 });
        assert.notEqual(r.status, 0);
        assert.ok(Array.isArray(r.json?.available));
    });
});

describe('CLI: unknown track', () => {
    test('an unknown track fails with guidance', () => {
        const r = run(['bogus', 'thing']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /unknown track/);
    });
});
