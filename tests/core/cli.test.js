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

describe('CLI: clean track', { timeout: 180_000 }, () => {
    // These run against the live instance, which may hold real user content.
    // Every confirm:true call therefore also passes requirePrefix so the run
    // aborts rather than touching anything outside the fixture namespace.
    const P = '__drvtest_';

    test('clean with no args is a dry run and deletes nothing', () => {
        const before = run(['api', 'characters.all']);
        const r = run(['clean', '--json', '{"showItems":0}']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.json.dryRun, true);
        assert.equal(r.json.confirmed, false);
        assert.deepEqual(r.json.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
        assert.ok(r.json.notes.some(n => n.includes('NOTHING WAS DELETED')));
        const after = run(['api', 'characters.all']);
        assert.equal(after.json.length, before.json.length, 'character count must be unchanged');
    });

    test('clean reports planned counts and the resolved scope', () => {
        const r = run(['clean', '--json', '{"showItems":0}']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.json.planned, 'planned present');
        for (const k of ['characters', 'groups', 'worldinfo', 'chats']) {
            assert.equal(typeof r.json.planned[k], 'number');
        }
        assert.deepEqual(Object.keys(r.json.scope).sort(), ['characters', 'chats', 'groups', 'settings', 'worldinfo']);
        assert.equal(r.json.scope.settings, false, 'settings is opt-in');
    });

    test('clean honours a scope subset', () => {
        const r = run(['clean', '--json', '{"scope":{"worldinfo":false,"groups":false},"showItems":0}']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.json.scope.worldinfo, false);
        assert.equal(r.json.scope.groups, false);
        assert.equal(r.json.planned.worldinfo, 0);
        assert.equal(r.json.planned.groups, 0);
    });

    test('clean protect excludes matching entries and lists them', async () => {
        // Create a fixture, then protect its prefix: it must drop out of `planned`
        // and show up in `protected` instead. Instance-agnostic - it does not
        // assume anything about what else is on the server.
        const name = `${P}prot_${Date.now().toString(36)}`;
        const created = run(['api', 'characters.create', '--json',
            JSON.stringify({ ch_name: name, description: 'd', first_mes: 'hi' })]);
        assert.equal(created.status, 0, created.stderr);
        try {
            const open = run(['clean', '--json', '{"showItems":0}']);
            const guarded = run(['clean', '--json', JSON.stringify({ protect: [name], showItems: 0 })]);
            assert.equal(guarded.status, 0, guarded.stderr);
            assert.equal(guarded.json.planned.characters, open.json.planned.characters - 1,
                'protecting the fixture must remove exactly it from the plan');
            assert.ok(guarded.json.protected.some(s => s.includes(name)), 'and report it as protected');
        } finally {
            run(['api', 'characters.delete', '--json', JSON.stringify([`${name}.png`, { deleteChats: true }])]);
        }
    });

    test('clean truncates the item list and says so', () => {
        const r = run(['clean', '--json', '{"showItems":1}']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.json.items.length <= 1);
        assert.equal(r.json.itemsShown, r.json.items.length);
        assert.equal(typeof r.json.itemsTotal, 'number');
        if (r.json.itemsTotal > 1) {
            assert.match(r.json.itemsTruncated, /more not shown/);
        }
    });

    test('clean showItems:0 lists everything', () => {
        const r = run(['clean', '--json', '{"showItems":0}']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.json.items.length, r.json.itemsTotal);
        assert.equal(r.json.itemsShown, r.json.itemsTotal);
        assert.equal(r.json.itemsTruncated, undefined,
            'no truncation note when everything is shown');
    });

    test('clean a negative showItems also means "all"', () => {
        const r = run(['clean', '--json', '{"showItems":-1}']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.json.items.length, r.json.itemsTotal);
    });

    test('clean omits showItems -> defaults to 25', () => {
        const r = run(['clean']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.json.items.length <= 25);
        if (r.json.itemsTotal > 25) {
            assert.match(r.json.itemsTruncated, /showItems":0/);
        }
    });

    test('clean confirm:true + requirePrefix aborts on non-fixture content', () => {
        // On an instance holding real content this must refuse; the exit code is
        // non-zero and nothing is deleted.
        const before = run(['api', 'characters.all']);
        const r = run(['clean', '--json', `{"confirm":true,"requirePrefix":"${P}","showItems":0}`]);
        const after = run(['api', 'characters.all']);
        assert.equal(after.json.length, before.json.length, 'nothing may be deleted');
        if (r.status !== 0) {
            assert.match(r.json?.error ?? r.stderr, /E_CLEAN_PREFIX_VIOLATION|do not start with/);
        }
    });

    test('clean deletes a fixture end to end through the CLI', () => {
        // Create a fixture + a chat log via the API track, wipe via the clean
        // track, confirm both gone. A protect list covering every non-fixture
        // card (plus the requirePrefix guard) makes this safe on an instance that
        // also holds real user content, and lets the run actually execute rather
        // than abort.
        const name = `${P}cli_${Date.now().toString(36)}`;
        const avatar = `${name}.png`;

        const allBefore = run(['api', 'characters.all']);
        const protect = allBefore.json
            .map(c => String(c.avatar))
            .filter(a => a && !a.startsWith(P));
        const worlds = run(['api', 'worldinfo.list']);
        for (const w of worlds.json ?? []) {
            const n = String(w.name ?? w.file_id ?? '');
            if (n && !n.startsWith(P)) protect.push(n);
        }
        const groups = run(['api', 'groups.all']);
        for (const g of groups.json ?? []) {
            if (String(g.name ?? '').startsWith(P)) continue;
            protect.push(String(g.name ?? ''), String(g.id ?? ''));
        }

        const created = run(['api', 'characters.create', '--json',
            JSON.stringify({ ch_name: name, description: 'd', first_mes: 'hi' })]);
        assert.equal(created.status, 0, created.stderr);
        const saved = run(['api', 'chats.save', '--json', JSON.stringify({
            avatarUrl: avatar,
            fileName: `${name} - 1`,
            chat: [{ user_name: 'You', character_name: name }, { name: 'You', is_user: true, mes: 'hi' }],
        })]);
        assert.equal(saved.status, 0, saved.stderr);

        const arg = JSON.stringify({ confirm: true, protect, requirePrefix: P, showItems: 0 });
        const dry = run(['clean', '--json', JSON.stringify({ ...JSON.parse(arg), confirm: false })]);
        assert.equal(dry.status, 0, dry.stderr);
        assert.equal(dry.json.planned.characters, 1, 'only the fixture is planned');
        assert.equal(dry.json.planned.chats, 1, 'its single log is planned');

        const r = run(['clean', '--json', arg]);
        assert.equal(r.status, 0, `${r.stderr}\n${JSON.stringify(r.json)}`);
        assert.equal(r.json.dryRun, false);
        assert.equal(r.json.confirmed, true);
        assert.equal(r.json.deleted.characters, 1, 'fixture card deleted');
        assert.equal(r.json.deleted.chats, 1, 'fixture log counted');
        assert.deepEqual(r.json.failures, []);

        const after = run(['api', 'characters.all']);
        assert.ok(!after.json.some(c => c.avatar === avatar), 'fixture card must be gone');
        assert.equal(after.json.length, allBefore.json.length, 'real content untouched');
    });

    test('clean against a named instance that is not running fails with guidance', () => {
        // 'prod' is a known env; if it happens to be running this asserts the
        // shape instead of the failure, so only check the reported target.
        const r = run(['clean', 'prod', '--json', '{"showItems":0}']);
        if (r.status === 0) {
            assert.match(r.json.resolvedFrom, /instance 'prod'/);
        } else {
            assert.match(r.json?.error ?? '', /cannot clean|nothing is answering|unknown instance/i);
        }
    });

    test('clean with --url targets that url', () => {
        const r = run(['clean', '--url', BASE_URL, '--json', '{"showItems":0}']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.json.target, BASE_URL);
        assert.equal(r.json.resolvedFrom, '--url');
    });
});

describe('CLI: unknown track', () => {
    test('an unknown track fails with guidance', () => {
        const r = run(['bogus', 'thing']);
        assert.notEqual(r.status, 0);
        assert.match(r.json?.error ?? '', /unknown track/);
    });
});
