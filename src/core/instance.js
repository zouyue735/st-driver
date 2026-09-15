/**
 * SillyTavern instance lifecycle management (start / stop / status).
 *
 * Environments are named presets pointing at local ST checkouts:
 *   test -> C:/Users/zouyue/SillyTavern/test/SillyTavern
 *   prod -> C:/Users/zouyue/SillyTavern/prod/SillyTavern
 *
 * Each instance runs `node server.js` as a detached background process, so it
 * survives this Node process exiting. stdout and stderr are both appended to a
 * dedicated, timestamped log file under <repo>/logs/:
 *   st-<env>-<YYYY-MM-DD_HH-mm-ss>.log
 *
 * The PID is recorded in <repo>/logs/<env>.pid so stop/status can find it later
 * (a fresh Node process has no handle on the spawned child).
 *
 * NOTE: both instances default to port 8000 (ST's own default), so they cannot
 * run simultaneously without overriding `port`. `status` reports this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (src/core -> repo). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** Directory holding instance logs and pid files. */
export const LOG_DIR = process.env.ST_LOG_DIR
    ? path.resolve(process.env.ST_LOG_DIR)
    : path.join(REPO_ROOT, 'logs');

/**
 * Named environments. Override per-call with `root`, or globally with the
 * ST_INSTANCE_TEST / ST_INSTANCE_PROD environment variables.
 */
export const DEFAULT_INSTANCES = Object.freeze({
    test: process.env.ST_INSTANCE_TEST ?? 'C:/Users/zouyue/SillyTavern/test/SillyTavern',
    prod: process.env.ST_INSTANCE_PROD ?? 'C:/Users/zouyue/SillyTavern/prod/SillyTavern',
});

/** @returns {string} '2026-09-12_19-45-03' (filename-safe local time) */
function timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** @returns {string} ISO local timestamp for log headers */
function isoNow() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class InstanceError extends Error {
    /**
     * @param {string} message
     * @param {Record<string, any>} [details]
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'InstanceError';
        Object.assign(this, details);
    }
}

export class InstanceManager {
    /**
     * @param {object} [options]
     * @param {Record<string,string>} [options.instances] extra/overriding named environments
     * @param {string} [options.logDir] override the log/pid directory
     */
    constructor(options = {}) {
        this.instances = { ...DEFAULT_INSTANCES, ...(options.instances ?? {}) };
        this.logDir = options.logDir ? path.resolve(options.logDir) : LOG_DIR;
    }

    /** @returns {string[]} known environment names */
    names() {
        return Object.keys(this.instances);
    }

    /**
     * Resolve an environment name (or explicit path) to an absolute root.
     * @param {string} env name from names(), or a filesystem path
     * @returns {string}
     * @throws {InstanceError} unknown name that is not an existing directory
     */
    resolveRoot(env) {
        if (!env || typeof env !== 'string') {
            throw new InstanceError(`instance name is required (one of: ${this.names().join(', ')}, or a path)`);
        }
        if (this.instances[env]) return path.resolve(this.instances[env]);
        // allow an ad-hoc path
        if (fs.existsSync(env) && fs.statSync(env).isDirectory()) return path.resolve(env);
        throw new InstanceError(
            `unknown instance '${env}' (known: ${this.names().join(', ')}) and not an existing directory`,
            { env, known: this.names() },
        );
    }

    /** @param {string} env @returns {string} pid file path */
    pidFile(env) {
        return path.join(this.logDir, `${env}.pid`);
    }

    /** @param {string} env @returns {string} runtime state file path */
    stateFile(env) {
        return path.join(this.logDir, `${env}.state.json`);
    }

    /**
     * Read the recorded PID for an environment.
     * @param {string} env
     * @returns {number|null}
     */
    readPid(env) {
        const file = this.pidFile(env);
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, 'utf8').trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }

    /**
     * Persist what we actually launched: pid, the EFFECTIVE port, log file and
     * start time.
     *
     * Why a separate state file: `status()` used to infer the port from
     * config.yaml, which is wrong when an instance is started with a `--port`
     * override - `instance list` then reported the wrong port and a false
     * `portOwnerMatches:false` for a perfectly healthy instance. Recording the
     * effective values at launch keeps status honest.
     *
     * @param {string} env
     * @param {{pid:number, port:number, logFile:string, root:string, startedAt:string}} state
     */
    #writeState(env, state) {
        fs.mkdirSync(this.logDir, { recursive: true });
        fs.writeFileSync(this.stateFile(env), JSON.stringify(state, null, 2), 'utf8');
    }

    /**
     * Read the recorded launch state, or null.
     * @param {string} env
     * @returns {{pid:number, port:number, logFile:string, root:string, startedAt:string}|null}
     */
    readState(env) {
        const file = this.stateFile(env);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }

    /** Remove both the pid file and the state file for an env. */
    #clearState(env) {
        fs.rmSync(this.pidFile(env), { force: true });
        fs.rmSync(this.stateFile(env), { force: true });
    }

    /**
     * Record a PID, creating the log directory first.
     *
     * `logs/` is normally created by start(), but `stop({adoptPortOwner:true})`
     * also needs to persist an adopted pid - and it can run before any start()
     * ever happened (e.g. adopting a manually launched server). Without this the
     * writeFileSync fails with ENOENT. Routing every pid write through here
     * removes that call-order dependency.
     * @param {string} env
     * @param {number} pid
     */
    #writePid(env, pid) {
        fs.mkdirSync(this.logDir, { recursive: true });
        fs.writeFileSync(this.pidFile(env), String(pid), 'utf8');
    }

    /**
     * Whether a given PID is a live process.
     * @param {number} pid
     * @returns {boolean}
     */
    isPidAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            // signal 0 = existence check, no signal delivered
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return e?.code === 'EPERM'; // exists but owned by another user
        }
    }

    /**
     * Probe the HTTP endpoint to confirm ST actually finished booting.
     * @param {string} baseUrl
     * @param {number} [timeout=5000]
     * @returns {Promise<{up:boolean, version?:object, error?:string}>}
     */
    async probe(baseUrl, timeout = 5000) {
        try {
            const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/version`, {
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
            return { up: true, version: await res.json() };
        } catch (e) {
            return { up: false, error: String(e?.message ?? e) };
        }
    }

    /**
     * Full status of one environment.
     *
     * Port resolution order: explicit `options.port` > the port recorded when the
     * instance was launched (state file) > the instance's config.yaml > 8000.
     * Using the recorded launch port is what makes `--port` overrides visible;
     * inferring from config.yaml alone reported the wrong port for an instance
     * started with an override.
     *
     * `portOwnerMatches` tells you whether the process actually holding that port
     * IS this env's recorded pid - important because test and prod both default
     * to 8000, so a bare probe cannot say which instance answered.
     *
     * @param {string} env
     * @param {object} [options]
     * @param {number} [options.port] force the port to probe
     * @returns {Promise<object>} {env, root, pid, running, http, port, portSource,
     *   portOwnerPid, portOwnerMatches, startedAt, startedAtSource, logFile,
     *   exists, hasServerJs, hasNodeModules, hasConfig}
     */
    async status(env, options = {}) {
        const root = this.resolveRoot(env);
        const state = this.readState(env);
        const pid = this.readPid(env);
        const running = pid !== null && this.isPidAlive(pid);
        // A recorded port is only meaningful while that pid is alive; otherwise a
        // stale state file from a dead launch would mislead us.
        const port = options.port
            ?? (running && state?.port ? state.port : null)
            ?? await this.#detectPort(root)
            ?? 8000;
        const portSource = options.port
            ? 'option'
            : (running && state?.port ? 'state' : 'config-or-default');
        const http = await this.probe(`http://localhost:${port}`);
        // Who actually holds the port, and is it us? (Windows only; null elsewhere)
        const portOwnerPid = this.#findPidOnPort(port);
        const logFile = this.latestLog(env);
        const startedAt = running ? (state?.startedAt ?? this.#startedAtFromLogName(logFile)) : null;
        return {
            env,
            root,
            pid,
            running,
            http,
            port,
            portSource,
            portOwnerPid,
            // true only when the live port owner IS this env's recorded pid
            portOwnerMatches: portOwnerPid !== null && pid !== null && portOwnerPid === pid,
            startedAt,
            // 'state' = recorded at launch; 'log-name' = recovered from the log
            // file name, so a second-resolution value parsed out of the file name
            // is never mistaken for a recorded one.
            startedAtSource: !running ? null : (state?.startedAt ? 'state' : (startedAt ? 'log-name' : null)),
            logFile,
            exists: fs.existsSync(root),
            hasServerJs: fs.existsSync(path.join(root, 'server.js')),
            hasNodeModules: fs.existsSync(path.join(root, 'node_modules')),
            hasConfig: fs.existsSync(path.join(root, 'config.yaml')),
        };
    }

    /**
     * Pre-flight validation: everything `node server.js` needs to boot.
     * @param {string} root
     * @returns {{ok:boolean, missing:string[]}}
     */
    #preflight(root) {
        const missing = [];
        if (!fs.existsSync(root)) missing.push(`instance root not found: ${root}`);
        else {
            if (!fs.existsSync(path.join(root, 'server.js'))) {
                missing.push(`server.js missing in ${root} (is this a SillyTavern checkout?)`);
            }
            if (!fs.existsSync(path.join(root, 'node_modules'))) {
                missing.push(`node_modules missing in ${root} - run: cd "${root}" && npm install`);
            }
        }
        return { ok: missing.length === 0, missing };
    }

    /**
     * Most recent log file for an environment (by mtime).
     * @param {string} env
     * @returns {string|null} absolute path
     */
    latestLog(env) {
        if (!fs.existsSync(this.logDir)) return null;
        const prefix = `st-${env}-`;
        const candidates = fs.readdirSync(this.logDir)
            .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
            .map(f => ({
                f,
                // Sort by the launch timestamp embedded in the FILE NAME, not by
                // mtime: the name is written at spawn time so it is authoritative
                // about which launch is newest, while mtime is identical for files
                // created in the same tick (making the old sort order arbitrary)
                // and moves every time a running server appends output.
                stamp: /^st-.+?-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.log$/.exec(f)?.[1] ?? '',
                m: fs.statSync(path.join(this.logDir, f)).mtimeMs,
            }))
            .sort((a, b) => (b.stamp.localeCompare(a.stamp)) || (b.m - a.m));
        return candidates.length ? path.join(this.logDir, candidates[0].f) : null;
    }

    /**
     * Recover the launch time from a log file NAME (`st-<env>-YYYY-MM-DD_HH-mm-ss.log`).
     *
     * status() reports startedAt from the state file, but a state file only exists
     * for launches this manager recorded - an instance started before that field
     * existed (or launched by hand) reports null even though the log plainly
     * carries the time. Parsing it back out of the file name keeps status honest
     * without reading file contents.
     *
     * @param {string|null} logFile absolute path from latestLog()
     * @returns {string|null} 'YYYY-MM-DD HH:mm:ss' or null when it cannot be parsed
     */
    #startedAtFromLogName(logFile) {
        if (!logFile) return null;
        const base = path.basename(logFile);
        if (!base.startsWith('st-')) return null;
        // Anchor on the trailing timestamp rather than parsing the env name out of
        // it: `env` may be an arbitrary directory path containing '-' (and ':'),
        // so `st-<env>-` is not a fixed-width prefix.
        const m = /(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.log$/.exec(base);
        if (!m) return null;
        return `${m[1]} ${m[2].replace(/-/g, ':')}`;
    }

    /**
     * Start an instance.
     *
     * @param {string} env name or path
     * @param {object} [options]
     * @param {number} [options.port] override the listening port (ST default 8000)
     * @param {string} [options.dataRoot] override the data directory
     * @param {boolean} [options.listen=false] bind all interfaces (remote access)
     * @param {boolean} [options.noBrowser=true] suppress ST's auto browser launch
     * @param {string[]} [options.args] extra raw args forwarded to server.js
     * @param {boolean} [options.force=false] stop an already-running instance first
     * @param {boolean} [options.wait=true] wait for the HTTP endpoint to come up
     * @param {number} [options.waitTimeout=60000] ms to wait for readiness
     * @param {Record<string,string>} [options.env] extra environment variables
     * @returns {Promise<{env:string, root:string, pid:number, logFile:string, port:number,
     *   ready:boolean, probe:object, startedAt:string, readyAt:string|null}>}
     *   `startedAt` is the spawn time (matches the log file name and banner);
     *   `readyAt` is when the HTTP endpoint answered, or null when wait=false
     * @throws {InstanceError} pre-flight failure, already running (without force), or boot timeout
     */
    async start(env, options = {}) {
        const root = this.resolveRoot(env);
        const { ok, missing } = this.#preflight(root);
        if (!ok) {
            throw new InstanceError(`cannot start '${env}': ${missing.join('; ')}`, { missing });
        }

        const port = options.port ?? await this.#detectPort(root) ?? 8000;
        const existingPid = this.readPid(env);
        if (existingPid !== null && this.isPidAlive(existingPid)) {
            if (!options.force) {
                throw new InstanceError(
                    `instance '${env}' appears to be running (pid ${existingPid}); pass force:true to restart it`,
                    { pid: existingPid },
                );
            }
            await this.stop(env, { gracefulTimeout: 8000 });
        }

        // Refuse to start into an occupied port rather than fight over it.
        // Note: this also catches a foreign process on the port (e.g. an ST
        // started manually outside this manager), which a pid-file check alone
        // would miss.
        const portHolder = this.#findPidOnPort(port);
        if (portHolder) {
            throw new InstanceError(
                `port ${port} is already in use by pid ${portHolder} (another ST instance?); ` +
                `start with a different port, or stop that process first`,
                { port, pid: portHolder },
            );
        }

        fs.mkdirSync(this.logDir, { recursive: true });
        const startedAt = timestamp();
        // Captured ONCE, before spawn: the banner and the returned startedAt must
        // agree with the log file name. (Taking this after the readiness wait
        // reported the READY time as the START time, several seconds later.)
        const startedAtIso = isoNow();
        const logFile = path.join(this.logDir, `st-${env}-${startedAt}.log`);

        const args = ['server.js'];
        if (options.port !== undefined) args.push('--port', String(port));
        if (options.dataRoot) args.push('--dataRoot', options.dataRoot);
        if (options.listen) args.push('--listen');
        // yargs boolean: must use the `=false` form; `--flag false` would treat
        // `false` as a positional argument. Suppresses ST's auto browser launch.
        if (options.noBrowser !== false) args.push('--browserLaunchEnabled=false');
        if (Array.isArray(options.args)) args.push(...options.args);

        // Write the launch banner, then hand the SAME fd to the child's
        // stdout+stderr. Using a file descriptor (not a piped stream we keep
        // open) is what lets a detached child outlive this process: Node dups
        // the handle into the child, and we can close our copy immediately.
        // (An earlier pipe()+stream.end() approach closed the file while the
        // server was still booting, losing all subsequent output.)
        const fd = fs.openSync(logFile, 'a');
        fs.writeSync(fd,
            `=== st-driver instance start ===\n` +
            `time:      ${startedAtIso}\n` +
            `env:       ${env}\n` +
            `root:      ${root}\n` +
            `command:   node ${args.join(' ')}\n` +
            `port:      ${port}\n` +
            `node:      ${process.version}\n` +
            `===============================\n\n`,
        );

        let child;
        try {
            child = spawn(process.execPath, args, {
                cwd: root,
                detached: true,          // survive this process exiting
                stdio: ['ignore', fd, fd],
                env: { ...process.env, ...(options.env ?? {}) },
                windowsHide: true,
            });
        } catch (e) {
            fs.closeSync(fd);
            throw new InstanceError(`failed to spawn '${env}': ${String(e?.message ?? e)}`, { root });
        }
        // Log the pid through the same fd, then close our copy. The child
        // inherited its own handle and keeps appending after we close ours.
        fs.writeSync(fd, `pid: ${child.pid}\n\n`);
        this.#writePid(env, child.pid);
        // Record the EFFECTIVE launch parameters so status()/list report the real
        // port (config.yaml cannot express a --port override).
        this.#writeState(env, {
            pid: child.pid,
            port,
            logFile,
            root,
            startedAt: startedAtIso,
        });
        fs.closeSync(fd);

        const exitedEarly = await new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            child.once('exit', (code, signal) => done({ code, signal }));
            child.once('error', (err) => done({ code: null, signal: null, error: String(err?.message ?? err) }));
            // give it a moment to fail fast (bad config, port taken)
            setTimeout(() => done(null), 1500);
        });

        if (exitedEarly) {
            fs.appendFileSync(logFile, `\n=== process exited early: ${JSON.stringify(exitedEarly)} ===\n`);
            this.#clearState(env);
            throw new InstanceError(
                `instance '${env}' exited immediately (code=${exitedEarly.code} signal=${exitedEarly.signal}${exitedEarly.error ? ` error=${exitedEarly.error}` : ''}); ` +
                `see ${logFile}`,
                { logFile, exit: exitedEarly },
            );
        }

        child.unref();

        let ready = false;
        let readyAt = null;
        let probe = { up: false, error: 'not probed' };
        if (options.wait !== false) {
            const deadline = Date.now() + (options.waitTimeout ?? 60_000);
            while (Date.now() < deadline) {
                if (!this.isPidAlive(child.pid)) {
                    throw new InstanceError(
                        `instance '${env}' died during startup; see ${logFile}`,
                        { logFile, pid: child.pid },
                    );
                }
                probe = await this.probe(`http://localhost:${port}`, 2000);
                if (probe.up) { ready = true; readyAt = isoNow(); break; }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!ready) {
                throw new InstanceError(
                    `instance '${env}' (pid ${child.pid}) did not answer http://localhost:${port}/version ` +
                    `within ${options.waitTimeout ?? 60_000}ms; see ${logFile}`,
                    { logFile, pid: child.pid, port, probe },
                );
            }
        }

        return {
            env, root, pid: child.pid, logFile, port, ready, probe,
            startedAt: startedAtIso,
            readyAt,
        };
    }

    /**
     * Stop a running instance.
     *
     * PLATFORM NOTE: on Windows there are no real POSIX signals - Node's
     * `process.kill(pid, 'SIGTERM')` maps to TerminateProcess, i.e. a hard kill.
     * ST therefore gets NO chance to run shutdown handlers / flush pending
     * debounced saves. Practically this is fine because ST persists chats and
     * settings on a short debounce during normal operation, but avoid stopping
     * an instance mid-write if you can help it (e.g. don't stop right after a
     * generation - give it a couple of seconds).
     *
     * @param {string} env name or path
     * @param {object} [options]
     * @param {number} [options.gracefulTimeout=5000] ms to wait after SIGTERM
     *   before force-killing the process tree
     * @param {boolean} [options.force=false] skip the SIGTERM attempt
     * @returns {Promise<{env:string, root:string, pid:number|null, stopped:boolean, method:string}>}
     */
    async stop(env, options = {}) {
        const root = this.resolveRoot(env);
        let pid = this.readPid(env);
        if (pid === null) {
            // No pid file: the instance may still be running because it was
            // started outside this manager (e.g. a manual `node server.js`).
            // Only with an explicit opt-in do we adopt the port owner and stop
            // it - guessing here could kill an unrelated process.
            if (!options.adoptPortOwner) {
                return {
                    env, root, pid: null, stopped: false, method: 'no-pid-file',
                    hint: 'instance was not started by this manager; pass adoptPortOwner:true ' +
                        '(with `port` if it is not the config.yaml one) to stop whatever holds that port',
                };
            }
            const port = options.port ?? await this.#detectPort(root) ?? 8000;
            const owner = this.#findPidOnPort(port);
            if (owner === null) {
                return { env, root, pid: null, stopped: false, method: `no-pid-file; nothing on port ${port}` };
            }
            pid = owner;
            // Adopt it: record pid + the port we found it on so status() agrees
            // while the stop is in flight.
            this.#writePid(env, pid);
            this.#writeState(env, {
                pid,
                port,
                logFile: this.latestLog(env),
                root,
                startedAt: null,   // unknown - not started by this manager
            });
        }
        if (!this.isPidAlive(pid)) {
            this.#clearState(env);
            return { env, root, pid, stopped: false, method: 'already-dead (stale pid file removed)' };
        }

        const gracefulTimeout = options.gracefulTimeout ?? 5000;
        if (!options.force) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch { /* fall through to force kill */ }
            const deadline = Date.now() + gracefulTimeout;
            while (Date.now() < deadline) {
                if (!this.isPidAlive(pid)) {
                    this.#clearState(env);
                    return { env, root, pid, stopped: true, method: 'SIGTERM' };
                }
                await new Promise(r => setTimeout(r, 250));
            }
        }

        // Force kill the whole tree (Windows needs taskkill; POSIX needs SIGKILL).
        this.#killTree(pid);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (!this.isPidAlive(pid)) break;
            await new Promise(r => setTimeout(r, 200));
        }
        this.#clearState(env);
        const stillAlive = this.isPidAlive(pid);
        return {
            env, root, pid, stopped: !stillAlive,
            method: stillAlive ? 'FAILED to kill' : 'force-kill',
        };
    }

    /**
     * Restart = stop (if running) then start.
     *
     * An explicit `options.port` wins; otherwise the port the instance was last
     * launched on is carried over. That matters for `--port` overrides: stop()
     * clears the state file, so without capturing the port first, restarting an
     * instance that was running on 8001 would silently fall back to the
     * config.yaml port (8000) and collide with the other environment.
     *
     * @param {string} env
     * @param {object} [options] forwarded to start()
     * @returns {Promise<object>} start() result plus `stoppedFirst`, `carriedPort`
     */
    async restart(env, options = {}) {
        const root = this.resolveRoot(env);
        const pid = this.readPid(env);
        const wasRunning = pid !== null && this.isPidAlive(pid);

        // Capture the effective port BEFORE stop() wipes the state file.
        const recordedPort = this.readState(env)?.port ?? null;
        const carriedPort = options.port ?? recordedPort ?? null;

        // Resolve the port we WILL start on, then verify it is usable BEFORE
        // killing anything. A restart that stops first and only then discovers
        // the port is taken leaves the user with nothing running - so fail fast
        // here instead.
        const targetPort = carriedPort ?? await this.#detectPort(root) ?? 8000;
        const holder = this.#findPidOnPort(targetPort);
        // The current instance holding the port is fine (we're about to stop it);
        // any OTHER holder means the restart cannot proceed.
        if (holder !== null && holder !== pid) {
            throw new InstanceError(
                `restart aborted for '${env}': port ${targetPort} is held by pid ${holder}, ` +
                `which is not this instance (pid ${pid ?? 'none'}); nothing was stopped. ` +
                `Pass port:${targetPort === 8000 ? '8001' : targetPort + 1} or free that port first`,
                { env, port: targetPort, holder, pid },
            );
        }

        // Also reject a missing dependency BEFORE destroying the running instance.
        const { ok, missing } = this.#preflight(root);
        if (!ok) {
            throw new InstanceError(
                `restart aborted for '${env}' (nothing was stopped): ${missing.join('; ')}`,
                { missing },
            );
        }

        let stoppedFirst = false;
        if (wasRunning) {
            await this.stop(env, { gracefulTimeout: options.gracefulTimeout ?? 8000 });
            stoppedFirst = true;
        }

        // We know the port explicitly now, so always pass it through (otherwise
        // start() would re-derive it and could land somewhere else).
        const result = await this.start(env, { ...options, port: targetPort, force: false });
        return { ...result, stoppedFirst, carriedPort: targetPort };
    }

    /**
     * Read the tail of an instance's log.
     * @param {string} env
     * @param {object} [options]
     * @param {number} [options.lines=40]
     * @param {string} [options.logFile] explicit file (default: latest for env)
     * @returns {{logFile:string|null, lines:string[]}}
     */
    tailLog(env, options = {}) {
        const logFile = options.logFile ?? this.latestLog(env);
        if (!logFile || !fs.existsSync(logFile)) return { logFile: null, lines: [] };
        const count = options.lines ?? 40;
        const all = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
        // A file ending in '\n' splits to a trailing '' element; drop exactly one
        // such artifact so `lines:N` returns N REAL lines rather than N-1 plus an
        // empty string.
        if (all.length && all[all.length - 1] === '') all.pop();
        return { logFile, lines: all.slice(Math.max(0, all.length - count)) };
    }

    /**
     * List every log file, newest first.
     * @param {string} [env] filter by environment
     * @returns {Array<{file:string, env:string|null, size:number, mtime:string}>}
     */
    listLogs(env) {
        if (!fs.existsSync(this.logDir)) return [];
        return fs.readdirSync(this.logDir)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const m = f.match(/^st-(.+?)-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.log$/);
                // Read the fields off the Stats object directly. Spreading
                // `...fs.statSync()` does NOT carry `mtime`/`size` reliably: in
                // modern Node those live on the prototype as getters, so the
                // spread yielded {} and the old `e.mtime.toISOString()` threw on
                // EVERY call. mtimeMs is a plain own property, so use that.
                const st = fs.statSync(path.join(this.logDir, f));
                return {
                    file: path.join(this.logDir, f),
                    env: m?.[1] ?? null,
                    startedAt: m?.[2] ?? null,
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                };
            })
            .filter(e => !env || e.env === env)
            .map(e => ({
                file: e.file, env: e.env, startedAt: e.startedAt, size: e.size,
                mtime: new Date(e.mtimeMs).toISOString(),
            }))
            .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    }

    /**
     * Read the configured port out of an instance's config.yaml (cheap parse, no
     * YAML dependency). Falls back to null when absent/unreadable.
     * @param {string} root
     * @returns {Promise<number|null>}
     */
    async #detectPort(root) {
        const file = path.join(root, 'config.yaml');
        if (!fs.existsSync(file)) return null;
        try {
            const text = fs.readFileSync(file, 'utf8');
            // top-level `port:` only (browserLaunch.port is indented)
            const m = text.match(/^port:\s*(\d+)\s*$/m);
            return m ? Number(m[1]) : null;
        } catch {
            return null;
        }
    }

    /**
     * Find a PID listening on a port (Windows only; null elsewhere or if unknown).
     * Used to refuse starting into an occupied port.
     * @param {number} port
     * @returns {number|null}
     */
    #findPidOnPort(port) {
        if (process.platform !== 'win32') return null;
        try {
            const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000 });
            for (const line of out.split(/\r?\n/)) {
                if (!line.includes('LISTENING')) continue;
                const parts = line.trim().split(/\s+/);
                // Proto  Local Address  Foreign Address  State  PID
                if (parts[1]?.endsWith(`:${port}`) && parts[3] === 'LISTENING') {
                    const pid = Number(parts[4]);
                    if (Number.isInteger(pid) && pid > 0) return pid;
                }
            }
        } catch { /* best effort */ }
        return null;
    }

    /**
     * Kill a process and its children.
     * @param {number} pid
     */
    #killTree(pid) {
        try {
            if (process.platform === 'win32') {
                execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, stdio: 'ignore' });
            } else {
                // negative pid targets the process group (we spawned detached)
                try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
            }
        } catch (e) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
}
