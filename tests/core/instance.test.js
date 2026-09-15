/**
 * Tests for InstanceManager (src/core/instance.js): start/stop/restart/status of
 * local SillyTavern checkouts, detached processes, timestamped logs, readiness.
 *
 * NOTHING HERE TOUCHES THE REAL test/prod INSTANCES. Every case runs against a
 * throwaway "fake instance root" in the OS temp directory containing a minimal
 * server.js that really listens on a high port and answers GET /version, plus an
 * injected logDir so pid/state files never land in the repo's logs/.
 *
 * The real lifecycle (spawn -> readiness probe -> pid/state files -> stop ->
 * restart) is exercised for real, because that is exactly where the four bugs
 * found during live testing lived.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { InstanceManager, InstanceError, DEFAULT_INSTANCES } from '../../src/core/instance.js';

/** High, unlikely-to-collide ports for the fake servers. */
const PORT_A = 18_911;
const PORT_B = 18_912;
const PORT_C = 18_913;

/** A minimal stand-in for ST's server.js: listens, answers /version, logs. */
const FAKE_SERVER = `
const http = require('http');
const port = Number(process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? ${PORT_A});
console.log('fake server booting on', port);
const srv = http.createServer((req, res) => {
    if (req.url === '/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pkgVersion: '0.0.0-fake', agent: 'FakeST:0.0.0' }));
    } else { res.writeHead(404); res.end('nope'); }
});
srv.listen(port, () => console.log('fake server LISTENING', port));
process.on('SIGTERM', () => process.exit(0));
// keep alive
setInterval(() => {}, 60_000);
`;

let tmpRoot;
let roots = {};
let logDirs = {};

/** Build a fake instance root: server.js + node_modules + config.yaml. */
function makeRoot(name, { port, withNodeModules = true, withServer = true, withConfig = true } = {}) {
    const root = path.join(tmpRoot, name);
    fs.mkdirSync(root, { recursive: true });
    if (withServer) fs.writeFileSync(path.join(root, 'server.js'), FAKE_SERVER);
    if (withNodeModules) fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    if (withConfig && port) fs.writeFileSync(path.join(root, 'config.yaml'), `port: ${port}\n`);
    return root;
}

/** A manager pointed entirely at temp dirs - never the repo logs/ or real roots. */
function makeManager(envs, logName) {
    const logDir = path.join(tmpRoot, `logs-${logName}`);
    fs.mkdirSync(logDir, { recursive: true });
    logDirs[logName] = logDir;
    return new InstanceManager({ instances: envs, logDir });
}

/** Wait until a pid stops being alive, or a timeout. */
async function waitDead(mgr, pid, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (!mgr.isPidAlive(pid)) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-driver-inst-'));
});

after(async () => {
    // Best-effort: kill any stray fake servers we may have left listening.
    for (const port of [PORT_A, PORT_B, PORT_C]) {
        try {
            const { execFileSync } = await import('node:child_process');
            if (process.platform === 'win32') {
                const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
                for (const line of out.split(/\r?\n/)) {
                    if (line.includes('LISTENING') && line.includes(`:${port}`)) {
                        const pid = Number(line.trim().split(/\s+/)[4]);
                        if (pid > 0) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
                    }
                }
            }
        } catch { /* best effort */ }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure / synchronous surface (no processes)
// ---------------------------------------------------------------------------

describe('InstanceManager: construction & resolution', () => {
    test('DEFAULT_INSTANCES exposes test and prod roots', () => {
        assert.ok(DEFAULT_INSTANCES.test);
        assert.ok(DEFAULT_INSTANCES.prod);
        assert.equal(Object.isFrozen(DEFAULT_INSTANCES), true);
    });

    test('names() lists the known environments', () => {
        const mgr = new InstanceManager({ instances: { foo: '/x/foo', bar: '/x/bar' } });
        assert.deepEqual(mgr.names().sort(), ['bar', 'foo', ...Object.keys(DEFAULT_INSTANCES)].sort());
    });

    test('constructor overrides logDir (resolved absolute)', () => {
        const mgr = new InstanceManager({ logDir: path.join(tmpRoot, 'custom-logs') });
        assert.equal(mgr.logDir, path.resolve(path.join(tmpRoot, 'custom-logs')));
    });

    test('resolveRoot maps a known env to its absolute root', () => {
        const root = makeRoot('r1');
        const mgr = makeManager({ r1: root }, 'resolve');
        assert.equal(mgr.resolveRoot('r1'), path.resolve(root));
    });

    test('resolveRoot accepts an ad-hoc existing directory path', () => {
        const root = makeRoot('r2');
        const mgr = makeManager({}, 'adhoc');
        assert.equal(mgr.resolveRoot(root), path.resolve(root));
    });

    test('resolveRoot throws InstanceError for an unknown name', () => {
        const mgr = makeManager({}, 'unknown');
        assert.throws(() => mgr.resolveRoot('does-not-exist'), err => {
            assert.equal(err.name, 'InstanceError');
            assert.match(err.message, /unknown instance/);
            assert.ok(Array.isArray(err.known));
            return true;
        });
    });

    test('resolveRoot throws for an empty/non-string env', () => {
        const mgr = makeManager({}, 'empty');
        assert.throws(() => mgr.resolveRoot(''), InstanceError);
        assert.throws(() => mgr.resolveRoot(null), InstanceError);
        assert.throws(() => mgr.resolveRoot(undefined), InstanceError);
    });

    test('pidFile / stateFile live under the injected logDir', () => {
        const mgr = makeManager({ x: makeRoot('pf') }, 'paths');
        assert.equal(mgr.pidFile('x'), path.join(logDirs.paths, 'x.pid'));
        assert.equal(mgr.stateFile('x'), path.join(logDirs.paths, 'x.state.json'));
    });
});

describe('InstanceManager: pid & state files', () => {
    test('readPid returns null when no pid file exists', () => {
        const mgr = makeManager({ x: makeRoot('np') }, 'nopid');
        assert.equal(mgr.readPid('x'), null);
    });

    test('readPid rejects non-integer and non-positive contents', () => {
        const mgr = makeManager({ x: makeRoot('badpid') }, 'badpid');
        fs.mkdirSync(logDirs.badpid, { recursive: true });
        for (const bad of ['abc', '0', '-5', '3.7', '']) {
            fs.writeFileSync(mgr.pidFile('x'), bad);
            assert.equal(mgr.readPid('x'), null, `readPid(${JSON.stringify(bad)}) should be null`);
        }
    });

    test('readPid round-trips a written pid', () => {
        const mgr = makeManager({ x: makeRoot('goodpid') }, 'goodpid');
        fs.writeFileSync(mgr.pidFile('x'), '4242');
        assert.equal(mgr.readPid('x'), 4242);
    });

    test('readState returns null when absent and parses when present', () => {
        const mgr = makeManager({ x: makeRoot('st') }, 'st');
        assert.equal(mgr.readState('x'), null);
        fs.mkdirSync(logDirs.st, { recursive: true });
        fs.writeFileSync(mgr.stateFile('x'), JSON.stringify({ pid: 1, port: 2 }));
        assert.deepEqual(mgr.readState('x'), { pid: 1, port: 2 });
    });

    test('readState returns null on corrupt JSON', () => {
        const mgr = makeManager({ x: makeRoot('stbad') }, 'stbad');
        fs.mkdirSync(logDirs.stbad, { recursive: true });
        fs.writeFileSync(mgr.stateFile('x'), '{not json');
        assert.equal(mgr.readState('x'), null);
    });

    test('isPidAlive: false for junk, true for this process', () => {
        const mgr = makeManager({}, 'alive');
        assert.equal(mgr.isPidAlive(null), false);
        assert.equal(mgr.isPidAlive(0), false);
        assert.equal(mgr.isPidAlive(-1), false);
        assert.equal(mgr.isPidAlive(3.5), false);
        assert.equal(mgr.isPidAlive('12'), false);
        assert.equal(mgr.isPidAlive(process.pid), true);
    });
});

describe('InstanceManager: pre-flight', () => {
    test('a complete root passes pre-flight', async () => {
        const root = makeRoot('ok-root', { port: PORT_A });
        const mgr = makeManager({ ok: root }, 'preflight-ok');
        // pre-flight is exercised through start(); a complete root starts fine.
        const st = await mgr.status('ok');
        assert.equal(st.exists, true);
        assert.equal(st.hasServerJs, true);
        assert.equal(st.hasNodeModules, true);
        assert.equal(st.hasConfig, true);
    });

    test('start refuses when server.js is missing', async () => {
        const root = makeRoot('no-server', { port: PORT_A, withServer: false });
        const mgr = makeManager({ ns: root }, 'no-server');
        await assert.rejects(() => mgr.start('ns'), err => {
            assert.equal(err.name, 'InstanceError');
            assert.match(err.message, /server\.js missing/);
            assert.ok(err.missing.some(m => m.includes('server.js')));
            return true;
        });
    });

    test('start refuses when node_modules is missing (tells you to npm install)', async () => {
        const root = makeRoot('no-nm', { port: PORT_A, withNodeModules: false });
        const mgr = makeManager({ nn: root }, 'no-nm');
        await assert.rejects(() => mgr.start('nn'), err => {
            assert.match(err.message, /node_modules missing/);
            assert.match(err.message, /npm install/);
            return true;
        });
    });

    test('start refuses when the root itself is missing', async () => {
        const mgr = makeManager({ gone: path.join(tmpRoot, 'nope-not-here') }, 'gone');
        await assert.rejects(() => mgr.start('gone'), InstanceError);
    });
});

describe('InstanceManager: startedAtFromLogName (via status)', () => {
    test('recovers the launch time from a log file name when no state exists', async () => {
        const root = makeRoot('logname', { port: PORT_A });
        const mgr = makeManager({ ln: root }, 'logname');
        const logDir = logDirs.logname;
        // A log file with a parseable timestamp but NO state file, and a live pid
        // (use this process so isPidAlive is true).
        fs.writeFileSync(path.join(logDir, 'st-ln-2025-12-31_23-59-58.log'), 'x');
        fs.writeFileSync(mgr.pidFile('ln'), String(process.pid));
        const st = await mgr.status('ln');
        assert.equal(st.startedAt, '2025-12-31 23:59:58');
        assert.equal(st.startedAtSource, 'log-name');
    });

    test('a state-file startedAt wins over the log name', async () => {
        const root = makeRoot('bothsrc', { port: PORT_A });
        const mgr = makeManager({ bs: root }, 'bothsrc');
        fs.writeFileSync(path.join(logDirs.bothsrc, 'st-bs-2020-01-01_00-00-00.log'), 'x');
        fs.writeFileSync(mgr.pidFile('bs'), String(process.pid));
        fs.writeFileSync(mgr.stateFile('bs'), JSON.stringify({ pid: process.pid, port: PORT_A, startedAt: '2024-06-06 06:06:06' }));
        const st = await mgr.status('bs');
        assert.equal(st.startedAt, '2024-06-06 06:06:06');
        assert.equal(st.startedAtSource, 'state');
    });

    test('an unparseable log name yields null startedAt', async () => {
        const root = makeRoot('badlog', { port: PORT_A });
        const mgr = makeManager({ bl: root }, 'badlog');
        fs.writeFileSync(path.join(logDirs.badlog, 'st-bl-nonsense.log'), 'x');
        fs.writeFileSync(mgr.pidFile('bl'), String(process.pid));
        const st = await mgr.status('bl');
        assert.equal(st.startedAt, null);
        assert.equal(st.startedAtSource, null);
    });

    test('startedAt is null when the instance is not running', async () => {
        const root = makeRoot('notrun', { port: PORT_A });
        const mgr = makeManager({ nr: root }, 'notrun');
        fs.writeFileSync(path.join(logDirs.notrun, 'st-nr-2025-01-01_00-00-00.log'), 'x');
        const st = await mgr.status('nr');
        assert.equal(st.running, false);
        assert.equal(st.startedAt, null);
    });
});

describe('InstanceManager: log helpers', () => {
    test('latestLog returns the newest log for the env, null when none', () => {
        const mgr = makeManager({ x: makeRoot('ll') }, 'latest');
        assert.equal(mgr.latestLog('x'), null);
        fs.writeFileSync(path.join(logDirs.latest, 'st-x-2025-01-01_00-00-00.log'), 'old');
        fs.writeFileSync(path.join(logDirs.latest, 'st-x-2025-01-02_00-00-00.log'), 'new');
        // newest by mtime; touch the second to be sure
        const newest = mgr.latestLog('x');
        assert.match(newest, /st-x-2025-01-02/);
    });

    test('latestLog ignores other envs', () => {
        const mgr = makeManager({ x: makeRoot('ll2'), y: makeRoot('ll2y') }, 'latest2');
        fs.writeFileSync(path.join(logDirs.latest2, 'st-y-2025-01-01_00-00-00.log'), 'other');
        assert.equal(mgr.latestLog('x'), null);
    });

    test('tailLog returns the last N lines', () => {
        const mgr = makeManager({ x: makeRoot('tl') }, 'tail');
        fs.writeFileSync(path.join(logDirs.tail, 'st-x-2025-01-01_00-00-00.log'), 'a\nb\nc\nd\ne\n');
        const t = mgr.tailLog('x', { lines: 2 });
        assert.deepEqual(t.lines.slice(-2), ['d', 'e']);
        assert.ok(t.logFile.endsWith('.log'));
    });

    test('tailLog returns empty when no log exists', () => {
        const mgr = makeManager({ x: makeRoot('tl2') }, 'tail2');
        assert.deepEqual(mgr.tailLog('x'), { logFile: null, lines: [] });
    });

    test('listLogs enumerates logs newest-first with parsed env', () => {
        const mgr = makeManager({ x: makeRoot('ls') }, 'listlogs');
        fs.writeFileSync(path.join(logDirs.listlogs, 'st-x-2025-01-01_00-00-00.log'), 'a');
        fs.writeFileSync(path.join(logDirs.listlogs, 'st-y-2025-01-02_00-00-00.log'), 'b');
        const all = mgr.listLogs();
        assert.equal(all.length, 2);
        const xs = mgr.listLogs('x');
        assert.equal(xs.length, 1);
        assert.equal(xs[0].env, 'x');
        assert.equal(xs[0].startedAt, '2025-01-01_00-00-00');
    });
});

// ---------------------------------------------------------------------------
// Live lifecycle: real spawn / probe / stop / restart against fake servers
// ---------------------------------------------------------------------------

describe('InstanceManager: start/stop/restart lifecycle', { timeout: 120_000 }, () => {
    test('start launches a detached server, waits for readiness, records pid+state+log', async () => {
        const root = makeRoot('live-start', { port: PORT_A });
        const mgr = makeManager({ ls: root }, 'live-start');
        const res = await mgr.start('ls', { port: PORT_A, waitTimeout: 20_000 });
        try {
            assert.equal(res.ready, true);
            assert.equal(res.port, PORT_A);
            assert.ok(res.pid > 0);
            assert.ok(res.probe.up, 'probe must report up');
            assert.equal(res.probe.version.pkgVersion, '0.0.0-fake');
            assert.ok(res.startedAt, 'startedAt recorded');
            assert.ok(res.readyAt, 'readyAt recorded');
            // pid + state files written
            assert.equal(mgr.readPid('ls'), res.pid);
            const state = mgr.readState('ls');
            assert.equal(state.pid, res.pid);
            assert.equal(state.port, PORT_A);
            assert.equal(state.startedAt, res.startedAt);
            // log file exists and carries the banner
            assert.ok(fs.existsSync(res.logFile));
            const log = fs.readFileSync(res.logFile, 'utf8');
            assert.match(log, /st-driver instance start/);
            assert.match(log, new RegExp(`port:\\s+${PORT_A}`));
            assert.match(log, new RegExp(`pid: ${res.pid}`));
            // status agrees
            const st = await mgr.status('ls');
            assert.equal(st.running, true);
            assert.equal(st.http.up, true);
            assert.equal(st.port, PORT_A);
            assert.equal(st.startedAtSource, 'state');
        } finally {
            await mgr.stop('ls', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('start refuses to launch into a port already held by another process', async () => {
        // Occupy PORT_B with our own detached listener first.
        const root = makeRoot('busy', { port: PORT_B });
        const mgr = makeManager({ busy: root }, 'busy');
        const squatter = spawn(process.execPath, ['-e',
            `const http=require('http');http.createServer((q,s)=>s.end('x')).listen(${PORT_B},()=>console.log('up'));setInterval(()=>{},60000);`,
        ], { stdio: 'ignore', detached: true });
        try {
            // wait for the squatter to bind
            await new Promise(r => setTimeout(r, 1200));
            await assert.rejects(() => mgr.start('busy', { port: PORT_B }), err => {
                assert.equal(err.name, 'InstanceError');
                assert.match(err.message, /already in use/);
                assert.equal(err.port, PORT_B);
                return true;
            });
        } finally {
            try { process.kill(-squatter.pid); } catch { try { process.kill(squatter.pid); } catch { /* gone */ } }
            if (process.platform === 'win32') {
                try { (await import('node:child_process')).execFileSync('taskkill', ['/PID', String(squatter.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
            }
        }
    });

    test('start with force stops an already-running instance first', async () => {
        const root = makeRoot('force', { port: PORT_A });
        const mgr = makeManager({ f: root }, 'force');
        const first = await mgr.start('f', { port: PORT_A, waitTimeout: 20_000 });
        const second = await mgr.start('f', { port: PORT_A, force: true, waitTimeout: 20_000 });
        try {
            assert.notEqual(second.pid, first.pid, 'a new pid means the old one was stopped');
            assert.equal(second.ready, true);
            assert.equal(mgr.readPid('f'), second.pid);
            assert.equal(mgr.isPidAlive(first.pid), false, 'first instance must be dead');
        } finally {
            await mgr.stop('f', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('start without force refuses when the same env is already running', async () => {
        const root = makeRoot('norun-twice', { port: PORT_A });
        const mgr = makeManager({ nrt: root }, 'nrt');
        await mgr.start('nrt', { port: PORT_A, waitTimeout: 20_000 });
        try {
            await assert.rejects(() => mgr.start('nrt', { port: PORT_A }), err => {
                assert.match(err.message, /appears to be running/);
                assert.ok(err.pid > 0);
                return true;
            });
        } finally {
            await mgr.stop('nrt', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('stop kills a running instance and clears its state', async () => {
        const root = makeRoot('stop', { port: PORT_A });
        const mgr = makeManager({ s: root }, 'stop');
        const res = await mgr.start('s', { port: PORT_A, waitTimeout: 20_000 });
        const pid = res.pid;
        const out = await mgr.stop('s', { force: true, gracefulTimeout: 3000 });
        assert.equal(out.stopped, true);
        assert.equal(out.pid, pid);
        assert.ok(await waitDead(mgr, pid), 'process must be gone');
        assert.equal(mgr.readPid('s'), null, 'pid file cleared');
        assert.equal(mgr.readState('s'), null, 'state file cleared');
    });

    test('stop with no pid file is a no-op (does not guess a port owner)', async () => {
        const root = makeRoot('stop-nopid', { port: PORT_A });
        const mgr = makeManager({ snp: root }, 'stop-nopid');
        const out = await mgr.stop('snp');
        assert.equal(out.stopped, false);
        assert.equal(out.method, 'no-pid-file');
        assert.match(out.hint, /adoptPortOwner/);
    });

    test('stop reports a stale (already-dead) pid file and removes it', async () => {
        const root = makeRoot('stop-stale', { port: PORT_A });
        const mgr = makeManager({ ss: root }, 'stop-stale');
        fs.writeFileSync(mgr.pidFile('ss'), '999999999'); // almost certainly not alive
        const out = await mgr.stop('ss');
        assert.equal(out.stopped, false);
        assert.match(out.method, /already-dead/);
        assert.equal(mgr.readPid('ss'), null, 'stale pid file removed');
    });

    test('restart stops then starts, carrying over the recorded port', async () => {
        const root = makeRoot('restart', { port: PORT_A });
        const mgr = makeManager({ r: root }, 'restart');
        const first = await mgr.start('r', { port: PORT_A, waitTimeout: 20_000 });
        const restarted = await mgr.restart('r', { waitTimeout: 20_000 });
        try {
            assert.equal(restarted.stoppedFirst, true);
            assert.equal(restarted.ready, true);
            assert.equal(restarted.carriedPort, PORT_A, 'port carried from the prior launch');
            assert.notEqual(restarted.pid, first.pid);
            assert.equal(mgr.isPidAlive(first.pid), false, 'old pid dead after restart');
            assert.equal(mgr.readPid('r'), restarted.pid);
        } finally {
            await mgr.stop('r', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('restart aborts BEFORE stopping when the target port is held by a foreign pid', async () => {
        const root = makeRoot('restart-foreign', { port: PORT_C });
        const mgr = makeManager({ rf: root }, 'restart-foreign');
        // Start ours on PORT_C, then make the port "foreign" by pointing restart at
        // a DIFFERENT recorded port that someone else owns. Simplest: occupy PORT_B
        // with a squatter, run ours on PORT_C, and ask restart to move to PORT_B.
        const squatter = spawn(process.execPath, ['-e',
            `const http=require('http');http.createServer((q,s)=>s.end('x')).listen(${PORT_B},()=>{});setInterval(()=>{},60000);`,
        ], { stdio: 'ignore', detached: true });
        const mine = await mgr.start('rf', { port: PORT_C, waitTimeout: 20_000 });
        try {
            await new Promise(r => setTimeout(r, 1200));
            await assert.rejects(() => mgr.restart('rf', { port: PORT_B, waitTimeout: 20_000 }), err => {
                assert.equal(err.name, 'InstanceError');
                assert.match(err.message, /restart aborted/);
                assert.match(err.message, /held by pid/);
                return true;
            });
            // crucial: our instance was NOT stopped by the aborted restart
            assert.equal(mgr.isPidAlive(mine.pid), true, 'restart must fail fast without stopping');
        } finally {
            await mgr.stop('rf', { force: true, gracefulTimeout: 2000 });
            try { process.kill(-squatter.pid); } catch { try { process.kill(squatter.pid); } catch { /* gone */ } }
            if (process.platform === 'win32') {
                try { (await import('node:child_process')).execFileSync('taskkill', ['/PID', String(squatter.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
            }
        }
    });

    test('restart aborts BEFORE stopping when pre-flight fails', async () => {
        const root = makeRoot('restart-nopreflight', { port: PORT_A });
        const mgr = makeManager({ rp: root }, 'restart-np');
        const mine = await mgr.start('rp', { port: PORT_A, waitTimeout: 20_000 });
        // Break the root AFTER start so restart's pre-flight fails.
        fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
        try {
            await assert.rejects(() => mgr.restart('rp', { port: PORT_A }), err => {
                assert.match(err.message, /restart aborted/);
                assert.match(err.message, /nothing was stopped/);
                return true;
            });
            assert.equal(mgr.isPidAlive(mine.pid), true, 'instance must still be running');
        } finally {
            fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
            await mgr.stop('rp', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('status distinguishes portSource: option vs state vs config-or-default', async () => {
        const root = makeRoot('portsrc', { port: PORT_A });
        const mgr = makeManager({ ps: root }, 'portsrc');
        // no pid/state -> config-or-default
        let st = await mgr.status('ps');
        assert.equal(st.portSource, 'config-or-default');
        assert.equal(st.port, PORT_A, 'read from config.yaml');
        // explicit option wins
        st = await mgr.status('ps', { port: PORT_C });
        assert.equal(st.portSource, 'option');
        assert.equal(st.port, PORT_C);
        // after a real start, state wins
        const res = await mgr.start('ps', { port: PORT_B, waitTimeout: 20_000 });
        try {
            st = await mgr.status('ps');
            assert.equal(st.portSource, 'state');
            assert.equal(st.port, PORT_B, 'the --port override is visible via state');
        } finally {
            await mgr.stop('ps', { force: true, gracefulTimeout: 2000 });
        }
        assert.ok(res.pid);
    });

    test('start with wait:false does not block on readiness', async () => {
        const root = makeRoot('nowait', { port: PORT_A });
        const mgr = makeManager({ nw: root }, 'nowait');
        const res = await mgr.start('nw', { port: PORT_A, wait: false });
        try {
            assert.equal(res.ready, false);
            assert.equal(res.readyAt, null);
            assert.ok(res.pid > 0);
        } finally {
            await mgr.stop('nw', { force: true, gracefulTimeout: 3000 });
        }
    });

    test('start reports a clean error when the child exits immediately', async () => {
        const root = makeRoot('exits', { port: PORT_A });
        // Overwrite server.js with one that exits at once.
        fs.writeFileSync(path.join(root, 'server.js'), 'console.log("bye"); process.exit(3);');
        const mgr = makeManager({ ex: root }, 'exits');
        await assert.rejects(() => mgr.start('ex', { port: PORT_A, waitTimeout: 5000 }), err => {
            assert.equal(err.name, 'InstanceError');
            assert.match(err.message, /exited immediately|died during startup/);
            return true;
        });
        assert.equal(mgr.readPid('ex'), null, 'state cleared after early exit');
    });

    test('start records a log banner with env, root, command and node version', async () => {
        const root = makeRoot('banner', { port: PORT_A });
        const mgr = makeManager({ bn: root }, 'banner');
        const res = await mgr.start('bn', { port: PORT_A, waitTimeout: 20_000 });
        try {
            const log = fs.readFileSync(res.logFile, 'utf8');
            assert.match(log, /env:\s+bn/);
            assert.match(log, /root:\s/);
            assert.match(log, /command:\s+node server\.js/);
            assert.match(log, /node:\s+v\d+/);
            assert.match(log, /--browserLaunchEnabled=false/, 'auto browser launch suppressed');
        } finally {
            await mgr.stop('bn', { force: true, gracefulTimeout: 2000 });
        }
    });
});

describe('InstanceManager: probe', () => {
    test('probe reports up:false for a port nobody listens on', async () => {
        const mgr = makeManager({}, 'probe-down');
        const res = await mgr.probe(`http://localhost:${PORT_C}`, 1500);
        assert.equal(res.up, false);
        assert.ok(res.error);
    });

    test('probe reports up:true with the version body for a live fake server', async () => {
        const root = makeRoot('probe-up', { port: PORT_A });
        const mgr = makeManager({ pu: root }, 'probe-up');
        await mgr.start('pu', { port: PORT_A, waitTimeout: 20_000 });
        try {
            const res = await mgr.probe(`http://localhost:${PORT_A}`);
            assert.equal(res.up, true);
            assert.equal(res.version.agent, 'FakeST:0.0.0');
        } finally {
            await mgr.stop('pu', { force: true, gracefulTimeout: 2000 });
        }
    });

    test('probe strips trailing slashes from the base url', async () => {
        const root = makeRoot('probe-slash', { port: PORT_A });
        const mgr = makeManager({ psl: root }, 'probe-slash');
        await mgr.start('psl', { port: PORT_A, waitTimeout: 20_000 });
        try {
            const res = await mgr.probe(`http://localhost:${PORT_A}///`);
            assert.equal(res.up, true);
        } finally {
            await mgr.stop('psl', { force: true, gracefulTimeout: 2000 });
        }
    });
});
