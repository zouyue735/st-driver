#!/usr/bin/env node
/**
 * st-driver CLI - one-shot command entry point for external agents.
 *
 * Usage:
 *   node src/cli.js api <module>.<method> [--json '<args-json>']
 *   node src/cli.js ui <command> [--json '<args-json>']
 *   node src/cli.js raw <method> <path> [--json '<body>']     # low-level HTTP
 *   node src/cli.js list                                      # list everything callable
 *
 * Examples:
 *   node src/cli.js api characters.all
 *   node src/cli.js api characters.create --json '{"name":"Test","description":"desc"}'
 *   node src/cli.js api worldinfo.get --json '{"name":"MyBook"}'
 *   node src/cli.js api tokenizers.encode --json '{"model":"gpt2","text":"hello"}'
 *   node src/cli.js ui commands                               # dump slash-command registry
 *   node src/cli.js ui stscript --json '{"script":"/echo hi"}'
 *   node src/cli.js ui send --json '{"character":"Name","text":"Hello","generate":true}'
 *   node src/cli.js ui state                                  # current UI navigation state
 *   node src/cli.js ui sampling                               # current sampling params
 *   node src/cli.js raw POST /api/settings/get
 *
 * Args JSON conventions:
 *   - positional-arg methods (e.g. tokenizers.encode(model, text)) accept an
 *     object whose keys are matched in the documented parameter order given
 *     by --json '["a","b"]' (array form) OR {args:[...]} wrapper.
 * Output: JSON on stdout (result or {error}); non-zero exit on failure.
 */
import { createStDriver, createUiDriver, STClient } from './index.js';
import { InstanceManager, InstanceError } from './core/instance.js';

const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';

function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}

function fail(message, extra = {}) {
    printJson({ error: message, ...extra });
    process.exit(1);
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') {
            args.json = argv[++i];
        } else if (a === '--url') {
            args.url = argv[++i];
        } else if (a === '--timeout') {
            args.timeout = Number(argv[++i]);
        } else if (a === '--headed') {
            args.headed = true;
        } else {
            args._.push(a);
        }
    }
    return args;
}

function parseJsonArg(raw) {
    if (raw === undefined || raw === null || raw === '') return {};
    try {
        return JSON.parse(raw);
    } catch (e) {
        fail(`--json is not valid JSON: ${e.message}`, { input: raw });
    }
}

/**
 * Convert {a:1,b:2} or [1,2] or {args:[1,2]} into a positional argument array.
 *
 * Object form: keys are matched against the declared parameter names, in
 * declared order (missing trailing params are simply not passed). When the
 * LAST declared parameter is named `options`, any keys not matching a declared
 * parameter are bundled into that trailing options object - so
 * `{"avatarUrl":"x.png","deleteChats":true}` maps to ('x.png', {deleteChats:true}).
 */
function toPositional(jsonArg, paramNames) {
    if (Array.isArray(jsonArg)) return jsonArg;
    if (Array.isArray(jsonArg.args)) return jsonArg.args;
    if (jsonArg && typeof jsonArg === 'object') {
        const positionalNames = paramNames.filter(p => p !== 'options');
        const args = positionalNames.filter(p => p in jsonArg).map(p => jsonArg[p]);
        if (paramNames[paramNames.length - 1] === 'options') {
            const rest = {};
            for (const key of Object.keys(jsonArg)) {
                if (!positionalNames.includes(key) && key !== 'options') rest[key] = jsonArg[key];
            }
            if (jsonArg.options !== undefined) Object.assign(rest, jsonArg.options);
            if (Object.keys(rest).length) args.push(rest);
        }
        if (args.length) return args;
    }
    return [];
}

// ---------------------------------------------------------------------------
// api track
// ---------------------------------------------------------------------------

/**
 * Parameter orders for methods that take POSITIONAL args, so that the object
 * form `--json '{"model":"gpt2","text":"hi"}'` maps onto (model, text).
 *
 * Keep in sync with src/api/*.js signatures. Methods NOT listed here are
 * assumed to take a single options object (or nothing), and `--json '{...}'`
 * is passed through as that one argument.
 *
 * NOTE: methods taking a Buffer (upload/editAvatar/import) are intentionally
 * omitted - the CLI cannot transport binary through JSON; use the raw track
 * or the programmatic API for those.
 */
const POSITIONAL_PARAMS = {
    // characters: get(avatarUrl), rename(avatarUrl,newName), export(avatarUrl,format), ...
    'characters.get': ['avatarUrl'],
    'characters.duplicate': ['avatarUrl'],
    'characters.delete': ['avatarUrl', 'options'],
    'characters.rename': ['avatarUrl', 'newName'],
    'characters.export': ['avatarUrl', 'format'],
    'characters.chats': ['avatarUrl', 'options'],
    'characters.editAttribute': ['avatarUrl', 'chName', 'field', 'value'],
    'characters.mergeAttributes': ['avatarUrlOrList', 'patch', 'options'],
    // groups: positional ids (NOT an options object)
    'groups.delete': ['id'],
    'groups.getChat': ['chatId'],
    'groups.chatInfo': ['chatId'],
    'groups.deleteChat': ['chatId'],
    'groups.saveChat': ['chatId', 'chat', 'force'],
    // worldinfo: get(name), delete(name), edit(name,data)
    'worldinfo.get': ['name'],
    'worldinfo.delete': ['name'],
    'worldinfo.edit': ['name', 'data'],
    'worldinfo.import': ['data', 'options'],
    // personas
    'personas.delete': ['avatar'],
    'personas.findAvatarByName': ['name'],
    'personas.setActivePersona': ['name'],
    // tokenizers
    'tokenizers.encode': ['model', 'text'],
    'tokenizers.decode': ['model', 'ids'],
    'tokenizers.openaiCount': ['model', 'messages'],
    'tokenizers.openaiEncode': ['model', 'text'],
    'tokenizers.openaiDecode': ['model', 'ids'],
    'tokenizers.remoteKoboldCount': ['text', 'url'],
    'tokenizers.remoteTextgenEncode': ['text', 'url', 'options'],
};

/**
 * Resolve `<module>.<method>` or `<module>.<Class>.<method>` against the driver.
 * Single-export modules (loadApi -> class instance) take the 2-part form;
 * namespace modules (e.g. uipresets -> {ThemesApi, MovingUiApi, ...}) take the
 * 3-part form, with the class instantiated on the client automatically.
 */
async function resolveApiTarget(st, moduleName, parts) {
    const mod = await st.loadApi(moduleName);
    if (!mod) fail(`api module '${moduleName}' is not available`);

    if (parts.length === 1) {
        // 2-part form: method directly on the module instance
        return { api: mod, methodName: parts[0], label: `${moduleName}.${parts[0]}` };
    }
    // 3-part form: namespace module -> Class -> method
    const [className, methodName] = parts;
    const Cls = mod[className];
    if (typeof Cls !== 'function') {
        fail(`'${className}' is not exported by api module '${moduleName}'`, {
            available: Object.keys(mod),
        });
    }
    return { api: new Cls(st.client), methodName, label: `${moduleName}.${className}.${methodName}` };
}

async function runApi(moduleName, parts, jsonArg, options) {
    const st = await createStDriver({ baseUrl: options.url ?? BASE_URL, timeout: options.timeout });
    try {
        const { api, methodName, label } = await resolveApiTarget(st, moduleName, parts);
        const fn = api?.[methodName];
        if (typeof fn !== 'function') {
            const proto = Object.getPrototypeOf(api ?? {});
            fail(`no method '${methodName}' on '${label.split('.').slice(0, -1).join('.')}'`, {
                available: proto && proto !== Object.prototype
                    ? Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor')
                    : Object.keys(api ?? {}),
            });
        }
        const paramNames = POSITIONAL_PARAMS[label];
        let callArgs;
        if (paramNames) {
            callArgs = toPositional(jsonArg, paramNames);
        } else if (jsonArg && Object.keys(jsonArg).length > 0) {
            callArgs = [jsonArg];
        } else {
            callArgs = [];
        }
        const result = await fn.apply(api, callArgs);
        printJson(result ?? null);
    } finally {
        await st.close();
    }
}

async function runRaw(method, path, jsonArg, options) {
    // Git Bash (MSYS) rewrites leading-slash args into Windows paths unless the
    // caller sets MSYS_NO_PATHCONV=1 or doubles the slash. Normalize both:
    //   '//api/x' -> '/api/x' ; mangled 'C:/Program Files/Git/api/x' -> '/api/x'
    if (path.startsWith('//')) path = path.slice(1);
    const msysMangled = path.match(/^[A-Za-z]:[/\\].*?[/\\](api[/\\].*|version|csrf-token)$/);
    if (msysMangled) path = '/' + msysMangled[1].replace(/\\/g, '/');
    const client = new STClient({ baseUrl: options.url ?? BASE_URL, timeout: options.timeout });
    await client.connect();
    try {
        let result;
        switch (String(method).toUpperCase()) {
            case 'GET':
                result = await client.getRaw(path);
                try { result = JSON.parse(result); } catch { /* keep text */ }
                break;
            case 'POST':
                result = await client.post(path, jsonArg ?? {});
                break;
            default:
                fail(`unsupported raw method: ${method}`);
        }
        printJson(result ?? null);
    } finally {
        await client.close();
    }
}

// ---------------------------------------------------------------------------
// ui track (one-shot browser session per invocation)
// ---------------------------------------------------------------------------

async function runUi(command, jsonArg, options) {
    const { session, close } = await createUiDriver({
        baseUrl: options.url ?? BASE_URL,
        headless: !options.headed,
        timeout: options.timeout ?? 120_000,
    });
    try {
        switch (command) {
            case 'commands': {
                printJson(await session.stscript.listCommands());
                break;
            }
            case 'stscript': {
                if (!jsonArg.script) fail('ui stscript requires {"script": "..."}');
                const r = await session.stscript.run(jsonArg.script, { strict: !!jsonArg.strict });
                printJson(r);
                break;
            }
            case 'state': {
                printJson(await session.state.save());
                break;
            }
            case 'characters': {
                printJson(await session.evaluate(() => SillyTavern.getContext().characters.map((c, index) => ({
                    index, name: c.name, avatar: c.avatar,
                }))));
                break;
            }
            case 'open-character': {
                if (!jsonArg.name) fail('ui open-character requires {"name": "..."}');
                await session.chat.openCharacterByName(jsonArg.name);
                printJson(await session.state.save());
                break;
            }
            case 'read-chat': {
                printJson(await session.chat.read({ includeSystem: !!jsonArg.includeSystem }));
                break;
            }
            case 'send': {
                // {character?, group?, text, generate?, forceCharacter?, timeout?}
                if (jsonArg.character) await session.chat.openCharacterByName(jsonArg.character);
                if (jsonArg.group) {
                    const groups = await session.groups.list();
                    const g = groups.find(x => x.name === jsonArg.group || String(x.id) === String(jsonArg.group));
                    if (!g) fail(`group not found: ${jsonArg.group}`);
                    await session.groups.open(g.id);
                }
                const genOpts = { timeout: jsonArg.timeout ?? 600_000 };
                if (jsonArg.forceCharacter !== undefined) {
                    const idx = await session.evaluate(({ name }) => {
                        return SillyTavern.getContext().characters.findIndex(c => c.name === name || c.avatar === name);
                    }, { name: jsonArg.forceCharacter });
                    if (idx < 0) fail(`character not found for forceCharacter: ${jsonArg.forceCharacter}`);
                    genOpts.forceCharacterId = idx;
                }
                let result;
                if (jsonArg.generate === false) {
                    result = await session.chat.sendUser(jsonArg.text ?? '');
                } else {
                    result = await session.generation.sendAndGenerate(jsonArg.text ?? '', genOpts);
                }
                printJson({ result, chat: await session.chat.read() });
                break;
            }
            case 'generate': {
                // {type?, forceCharacter?, timeout?} - generate without sending
                const genOpts = { type: jsonArg.type ?? 'normal', timeout: jsonArg.timeout ?? 600_000 };
                if (jsonArg.forceCharacter !== undefined) {
                    const idx = await session.evaluate(({ name }) => {
                        return SillyTavern.getContext().characters.findIndex(c => c.name === name || c.avatar === name);
                    }, { name: jsonArg.forceCharacter });
                    if (idx < 0) fail(`character not found: ${jsonArg.forceCharacter}`);
                    genOpts.forceCharacterId = idx;
                }
                printJson(await session.generation.generate(genOpts));
                break;
            }
            case 'connect': {
                // establish/verify the API connection so generation works.
                // {source?, model?, force?}
                let result;
                if (jsonArg.source || jsonArg.model) {
                    result = await session.connection.select(jsonArg);
                } else {
                    result = await session.connection.connect({ force: jsonArg.force });
                }
                printJson({ connect: result, status: await session.connection.status() });
                break;
            }
            case 'connection': {
                printJson(await session.connection.status());
                break;
            }
            case 'sampling': {
                if (jsonArg.set) {
                    printJson(await session.settings.setSampling(jsonArg.set, { save: !!jsonArg.save }));
                } else {
                    printJson(await session.settings.getSampling());
                }
                break;
            }
            case 'persona': {
                // {action: list|active|set|create|delete, ...}
                const action = jsonArg.action ?? 'list';
                switch (action) {
                    case 'list': printJson(await session.personas.list()); break;
                    case 'active': printJson(await session.personas.active()); break;
                    case 'set': printJson(await session.personas.set(jsonArg.name)); break;
                    case 'create': printJson({ avatarKey: await session.personas.create(jsonArg) }); break;
                    case 'delete': printJson(await session.personas.delete(jsonArg.name, { silent: true })); break;
                    default: fail(`unknown persona action: ${action}`);
                }
                break;
            }
            case 'groups': {
                printJson(await session.groups.list());
                break;
            }
            default:
                fail(`unknown ui command: ${command}`, {
                    available: ['commands', 'stscript', 'state', 'characters', 'open-character',
                        'read-chat', 'send', 'generate', 'connect', 'connection', 'sampling', 'persona', 'groups'],
                });
        }
    } finally {
        await close();
    }
}

// ---------------------------------------------------------------------------

/**
 * `instance` track: manage local SillyTavern instances (start/stop/restart/status/logs).
 *
 * @param {string|undefined} action start|stop|restart|status|logs|list
 * @param {string|undefined} env instance name (test|prod) or a path
 * @param {object} jsonArg {port, dataRoot, listen, force, lines, wait, ...}
 * @param {object} options CLI options
 */
async function runInstance(action, env, jsonArg, options) {
    const manager = new InstanceManager();

    if (!action) {
        fail('instance track needs an action: start|stop|restart|status|logs|list', {
            knownInstances: manager.names(),
        });
    }

    switch (action) {
        case 'list': {
            const out = { logDir: manager.logDir, instances: {} };
            for (const name of manager.names()) {
                out.instances[name] = await manager.status(name, { port: jsonArg.port });
            }
            printJson(out);
            break;
        }
        case 'status': {
            if (!env) fail('instance status needs <env> (e.g. test, prod)');
            printJson(await manager.status(env, { port: jsonArg.port }));
            break;
        }
        case 'start': {
            if (!env) fail('instance start needs <env> (e.g. test, prod)');
            const result = await manager.start(env, {
                port: jsonArg.port,
                dataRoot: jsonArg.dataRoot,
                listen: jsonArg.listen,
                force: jsonArg.force,
                wait: jsonArg.wait,
                waitTimeout: jsonArg.waitTimeout ?? options.timeout,
                args: jsonArg.args,
            });
            printJson(result);
            break;
        }
        case 'stop': {
            if (!env) fail('instance stop needs <env> (e.g. test, prod)');
            printJson(await manager.stop(env, {
                force: jsonArg.force,
                gracefulTimeout: jsonArg.gracefulTimeout,
                adoptPortOwner: jsonArg.adoptPortOwner,
                port: jsonArg.port,
            }));
            break;
        }
        case 'restart': {
            if (!env) fail('instance restart needs <env> (e.g. test, prod)');
            const result = await manager.restart(env, {
                port: jsonArg.port,
                dataRoot: jsonArg.dataRoot,
                listen: jsonArg.listen,
                wait: jsonArg.wait,
                waitTimeout: jsonArg.waitTimeout ?? options.timeout,
                args: jsonArg.args,
            });
            printJson(result);
            break;
        }
        case 'logs': {
            if (!env) fail('instance logs needs <env> (e.g. test, prod)');
            const { logFile, lines } = manager.tailLog(env, { lines: jsonArg.lines });
            if (!logFile) fail(`no log file found for instance '${env}'`, { logDir: manager.logDir });
            // human-readable tail, since that is the point of this command
            console.log(`# ${logFile}`);
            console.log(lines.join('\n'));
            break;
        }
        default:
            fail(`unknown instance action: ${action} (expected start|stop|restart|status|logs|list)`);
    }
}

async function listAll() {
    const out = { tracks: {} };
    const st = await createStDriver({ baseUrl: BASE_URL }).catch(() => null);
    if (st) {
        const { loaded, missing } = await st.loadAll();
        out.tracks.api = {};
        for (const name of loaded) {
            const mod = st.api[name];
            const proto = Object.getPrototypeOf(mod);
            if (proto && proto !== Object.prototype) {
                // single-export module: instance of an API class
                out.tracks.api[name] = Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor');
            } else {
                // namespace module: enumerate each exported class + its methods
                out.tracks.api[name] = {};
                for (const [exportName, value] of Object.entries(mod)) {
                    if (typeof value === 'function' && value.prototype) {
                        out.tracks.api[name][exportName] = Object.getOwnPropertyNames(value.prototype)
                            .filter(n => n !== 'constructor');
                    }
                }
            }
        }
        out.tracks.apiMissing = missing;
        await st.close();
    }
    out.tracks.ui = {
        session: ['connection', 'chat', 'generation', 'stscript', 'personas', 'groups', 'settings', 'state'],
        cliCommands: ['commands', 'stscript', 'state', 'characters', 'open-character',
            'read-chat', 'send', 'generate', 'connect', 'connection', 'sampling', 'persona', 'groups'],
    };
    // instance track: named environments + their recorded runtime state (no HTTP
    // probing here, so `list` stays fast and works while nothing is running)
    const manager = new InstanceManager();
    out.tracks.instance = {
        actions: ['start', 'stop', 'restart', 'status', 'logs', 'list'],
        logDir: manager.logDir,
        environments: Object.fromEntries(
            manager.names().map(name => [name, {
                root: manager.resolveRoot(name),
                pid: manager.readPid(name),
                running: (() => {
                    const pid = manager.readPid(name);
                    return pid !== null && manager.isPidAlive(pid);
                })(),
            }]),
        ),
    };
    printJson(out);
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
        console.log(`st-driver CLI

Usage:
  node src/cli.js list
  node src/cli.js api <module>.<method> [--json '<args>']
  node src/cli.js ui <command> [--json '<args>']
  node src/cli.js raw <GET|POST> <path> [--json '<body>']
  node src/cli.js instance <action> [env] [--json '<args>']

Instance management (start/stop local SillyTavern checkouts):
  instance list                     status of every known env
  instance status <env>             one env (test|prod|<path>)
  instance start <env> [--json '{"port":8000,"force":true,"dataRoot":"...","listen":false,"wait":true,"waitTimeout":60000}']
  instance stop <env> [--json '{"force":false,"gracefulTimeout":5000,"adoptPortOwner":false,"port":8000}']
  instance restart <env> [--json '{...same as start}']
  instance logs <env> [--json '{"lines":80}']   tail the newest launch log

  stop only acts on instances this manager started (it tracks them via
  logs/<env>.pid). If an instance was started manually, pass
  adoptPortOwner:true to stop whatever process holds the port - it will NOT
  guess otherwise, since that could kill an unrelated process.

  Each start writes <repo>/logs/st-<env>-<timestamp>.log (stdout+stderr merged,
  launch banner with time/root/command/port) and records logs/<env>.pid.
  Default envs: test=C:/Users/zouyue/SillyTavern/test/SillyTavern,
                prod=C:/Users/zouyue/SillyTavern/prod/SillyTavern
  (override with ST_INSTANCE_TEST / ST_INSTANCE_PROD, or pass a path as <env>).
  Both default to port 8000 - they cannot run at once without --json '{"port":N}'.

Options:
  --url <baseUrl>      ST server (default $ST_URL or http://localhost:8000)
  --json <json>        arguments (object or array)
  --timeout <ms>       request/launch timeout
  --headed             run browser visible (ui track)

Run 'node src/cli.js list' for the full command surface.`);
        return;
    }
    const options = parseArgs(argv);
    const [track, target] = options._;
    const jsonArg = parseJsonArg(options.json);

    switch (track) {
        case 'list':
            await listAll();
            break;
        case 'api': {
            if (!target?.includes('.')) fail("api track needs <module>.<method> (or <module>.<Class>.<method>), e.g. 'characters.all'");
            const [moduleName, ...parts] = target.split('.');
            await runApi(moduleName, parts, jsonArg, options);
            break;
        }
        case 'ui':
            await runUi(target, jsonArg, options);
            break;
        case 'raw': {
            // argv layout: [track, method, path] -> _[0]=api|ui|raw, _[1]=method, _[2]=path
            const [method, path] = [options._[1], options._[2]];
            if (!method || !path) fail('raw track needs <method> <path>');
            await runRaw(method, path, jsonArg, options);
            break;
        }
        case 'instance': {
            // argv layout: instance <action> [env] -> _[1]=action, _[2]=env
            await runInstance(options._[1], options._[2], jsonArg, options);
            break;
        }
        default:
            fail(`unknown track: ${track} (expected api|ui|raw|instance|list)`);
    }
}

main().catch(e => {
    fail(e?.message ?? String(e), { stack: String(e?.stack ?? '').split('\n').slice(0, 6) });
});
