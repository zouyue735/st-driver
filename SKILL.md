---
name: st-driver
description: Drive a running SillyTavern instance programmatically. Use when a task involves SillyTavern (ST) automation - characters, group chats, world info/lorebooks, chats, personas, presets, sampling parameters, STscript, message generation, swipes - via its HTTP API or live UI. Covers both the full /api/* surface (data CRUD) and frontend-only features (generation pipeline, STscript execution, persona switching) through a Playwright browser session.
version: 0.1.0
---

# SillyTavern Driver

A modular, test-driven Node.js driver that lets agents fully control a running
SillyTavern instance (verified against ST **1.18.0**, localhost:8000).

Two tracks, one skill:

| Track | Covers | When to use |
|---|---|---|
| **HTTP API** (`src/api/*`) | All `/api/*` endpoints: characters, chats, groups, world info, settings, presets, secrets, tokenizers, personas, media, files, vectors, backends | Any data CRUD; fast; no browser needed |
| **UI / Playwright** (`src/ui/*`) | Everything that only exists in the frontend: the generation pipeline (full prompt assembly), all ~470 STscript slash commands, persona switching, group member triggers, live sampling edits, events | Sending messages that get AI replies, running STscript, anything "as the UI does it" |

## Prerequisites

- SillyTavern running locally (default `http://localhost:8000`; override with `ST_URL`).
- Default single-user config (whitelist localhost, no basic auth). The driver performs the
  CSRF handshake automatically (`GET /csrf-token` → session cookie + `X-CSRF-Token`).
- Node.js >= 20. For the UI track: a system Edge or Chrome install (playwright-core
  auto-detects; override with `ST_BROWSER_PATH`).
- Install once: `npm install` inside this skill directory.

## Quick start (Node, programmatic)

```js
import { STClient } from '<skill>/src/core/client.js';
import { UiSession } from '<skill>/src/ui/session.js';

// --- HTTP track: data CRUD ---
const client = new STClient({ baseUrl: 'http://localhost:8000' });
await client.connect();
const { CharactersApi } = await import('<skill>/src/api/characters.js');
const chars = new CharactersApi(client);
const all = await chars.all();

// --- UI track: generation & STscript ---
const session = new UiSession({ baseUrl: 'http://localhost:8000' });
await session.launch();
await session.chat.openCharacterByName('Some Character');
const result = await session.generation.sendAndGenerate('Hello!');
console.log(result.lastMessage.mes);
const pipe = await session.stscript.runOrThrow('/add 2 3'); // '5'
await session.close();
```

## Quick start (CLI, one-shot commands)

The CLI is the lowest-friction path for an agent: one bash call, JSON on stdout.

```bash
cd <skill-dir>
node src/cli.js list                     # full command surface (api modules + methods, ui commands)
node src/cli.js api <module>.<method> [--json '<args>']
node src/cli.js ui <command> [--json '<args>']
node src/cli.js raw <GET|POST> <path> [--json '<body>']   # escape hatch, any endpoint
```

### api track — recipes

```bash
# characters (card fields use ST's own names: ch_name, first_mes, ...)
node src/cli.js api characters.all
node src/cli.js api characters.get --json '["Foo.png"]'
node src/cli.js api characters.create --json '{"ch_name":"Test","description":"...","first_mes":"Hi"}'
node src/cli.js api characters.editAttribute --json '["Foo.png","Test","description","new text"]'
node src/cli.js api characters.delete --json '["Foo.png"]'
node src/cli.js api characters.export --json '{"avatarUrl":"Foo.png","format":"json"}'

# chats (JSONL: element 0 is the header object)
node src/cli.js api chats.get --json '{"avatarUrl":"Foo.png","fileName":"Foo - 2026-01-01"}'
node src/cli.js api chats.search --json '{"avatarUrl":"Foo.png"}'
node src/cli.js api chats.recent --json '{"max":10}'

# groups (activationStrategy 0=NATURAL 1=LIST 2=MANUAL 3=POOLED; generationMode 0=SWAP 1=APPEND)
node src/cli.js api groups.all
node src/cli.js api groups.create --json '{"name":"My Group","members":["A.png","B.png"],"activationStrategy":1}'

# world info (all ~44 entry fields supported; see docs/API.md)
node src/cli.js api worldinfo.list
node src/cli.js api worldinfo.get --json '["MyBook"]'

# settings / presets / secrets / tokenizers / personas
node src/cli.js api settings.getSettings
node src/cli.js api tokenizers.encode --json '{"model":"gpt2","text":"hello"}'
node src/cli.js api personas.listPersonas
node src/cli.js api secrets.read
```

Argument forms: `--json '{"a":1}'` passes one object argument (keys are mapped to
positional params for positional methods, e.g. `tokenizers.encode`);
`--json '["a","b"]'` passes explicit positional arguments. Namespace modules use
the 3-part form `api <module>.<Class>.<method>` (e.g. `uipresets.ThemesApi.delete`).

### ui track — recipes (one headless browser launch per call, ~10s)

```bash
node src/cli.js ui commands                                     # dump all ~470 slash commands + args
node src/cli.js ui stscript --json '{"script":"/setvar key=score 5"}'
node src/cli.js ui characters                                   # index/name/avatar of every character
node src/cli.js ui open-character --json '{"name":"Foo"}'
node src/cli.js ui read-chat
node src/cli.js ui send --json '{"character":"Foo","text":"Hello!","generate":true}'
node src/cli.js ui send --json '{"group":"My Group","text":"Continue","forceCharacter":"Bar"}'
node src/cli.js ui generate --json '{"type":"normal","timeout":300000}'
node src/cli.js ui sampling --json '{"set":{"temperature":0.9}}'
node src/cli.js ui persona --json '{"action":"set","name":"Bob"}'
node src/cli.js ui state
```

For multi-step UI work keep one `UiSession` open programmatically instead of
paying the browser launch per call.

### instance track — start/stop local SillyTavern checkouts

Two named environments ship preconfigured (override with `ST_INSTANCE_TEST` /
`ST_INSTANCE_PROD`, or pass any path in place of the env name):

| env | root |
|---|---|
| `test` | `C:/Users/zouyue/SillyTavern/test/SillyTavern` |
| `prod` | `C:/Users/zouyue/SillyTavern/prod/SillyTavern` |

```bash
node src/cli.js instance list                       # status of both envs
node src/cli.js instance status test
node src/cli.js instance start test                 # detached, waits until HTTP is up
node src/cli.js instance start prod --json '{"port":8001}'   # prod alongside test
node src/cli.js instance stop test
node src/cli.js instance restart test
node src/cli.js instance logs test --json '{"lines":80}'
```

Programmatic: `import { InstanceManager } from '<skill>/src/index.js'` then
`await new InstanceManager().start('test', { port: 8001, force: true })`.

Behavior worth knowing before you use it:

- **Logs**: each start writes `<skill>/logs/st-<env>-<YYYY-MM-DD_HH-mm-ss>.log`
  with a banner (time, root, full command, port, node version), then merged
  stdout+stderr. `logs/<env>.pid` records the pid; `logs/<env>.state.json` records
  the effective launch parameters (pid, port, log file, start time) so `status`
  reports `--port` overrides correctly. `logs/` is gitignored.
- **`startedAtSource`** tells you where `status.startedAt` came from: `'state'`
  (recorded at launch) or `'log-name'` (parsed back out of the log file name for
  instances launched before state files existed). Both are local-time strings.
- **Detached**: the server survives the CLI process exiting.
- **Both envs default to port 8000**, so they cannot run simultaneously unless
  one is given `--json '{"port":N}'`.
- **Pre-flight**: refuses to start when `server.js` or `node_modules` is missing
  (tells you the exact `npm install` command), and refuses when the target port
  is already held by another process.
- **`stop` only touches what this manager started.** For an instance launched
  manually, pass `--json '{"adoptPortOwner":true}'`; it never guesses, because
  killing the wrong process is unrecoverable.
- **Windows has no real SIGTERM** — `stop` is effectively a hard kill, so ST gets
  no chance to flush pending debounced saves. Don't stop an instance immediately
  after a generation; give it a couple of seconds.
- **`status` distinguishes "port answered" from "this env answered"**: since both
  envs share port 8000, `http.up: true` alone does not tell you which instance
  replied — check `portOwnerMatches` (true only when the port owner IS this env's
  recorded pid).

## Module map

### Core (`src/core/`)
- `client.js` — `STClient`: CSRF+cookie auth, JSON/text/binary/multipart POST, `StApiError`.
- `browser.js` — `StBrowser`: launches system Edge/Chrome, waits for APP_READY, evaluate helpers, generation-idle detection.
- `stscript.js` — `StscriptBridge`: run any STscript, strict mode, command-registry dump, event subscribe/poll.
- `instance.js` — `InstanceManager`: start/stop/restart/status local ST checkouts by named env (`test`/`prod`/path), detached background process, timestamped merged stdout+stderr log, HTTP readiness wait. See "Instance management" below.

### HTTP API (`src/api/`) — each class takes an `STClient`
- `characters.js` — `CharactersApi`: all/get/create/edit/editAttribute/editAvatar/mergeAttributes/rename/duplicate/delete/chats/export/import
- `chats.js` — `ChatsApi`: save/get/rename/delete/search/recent/export/import (+ swipes in message objects)
- `groups.js` — `GroupsApi`: all/create/edit/delete + group chats (getChat/saveChat/chatInfo/deleteChat); enums `GroupActivationStrategy` (NATURAL/LIST/MANUAL/POOLED), `GroupGenerationMode` (SWAP/APPEND/APPEND_DISABLED)
- `worldinfo.js` — `WorldInfoApi`: list/get/edit/delete/import; enums `EntryPosition`, `SelectiveLogic`, `EntryRole`; full ~44-field entry support
- `settings.js` — `SettingsApi`: get/save/snapshots
- `presets.js` — `PresetsApi`: save/delete/restore across all 9 apiIds (`PRESET_API_IDS`)
- `secrets.js` — `SecretsApi`: write/read/find/view/delete/rotate/rename/settings
- `tokenizers.js` — `TokenizersApi`: encode/decode/count for all 15+ models
- `personas.js` — `PersonasApi`: avatar file CRUD + settings-level persona metadata (create/update/delete/setActive), `me()`
- `media.js` — namespace module: `FilesApi` (Data Bank files), `ImagesApi` (base64 JSON upload), `ImageMetadataApi` (virtual folders), `AssetsApi`, `MediaApi` facade
- `backgrounds.js` — `BackgroundsApi`: all/folders/upload/rename/delete
- `sprites.js` — `SpritesApi`: expression sprites get/upload/uploadZip/delete
- `vectors.js` — `VectorsApi`: insert/list/query/queryMulti/delete/purge (always sends `source` explicitly — see API.md pitfall)
- `maintenance.js` — namespace: `StatsApi`, `BackupsApi`, `DataMaidApi`
- `extensions.js` — `ExtensionsApi`: discover/version (third-party git ops implemented; `/install` deliberately not wrapped — clones+runs third-party code)
- `uipresets.js` — namespace: `ThemesApi`, `MovingUiApi`, `QuickRepliesApi`
- `backends.js` — `BackendsApi`: chat-completions (status/generate/stream/bias/process), text-completions, kobold; `CHAT_COMPLETION_SOURCES` (26 providers), `mapFields` field mapping
- `external-ai.js` — namespace: `TranslateApi` (8 providers), `CaptionApi`, `ClassifyApi`, `SpeechApi`
- `sd.js` — `StableDiffusionApi`: 10 routes (ping/models/samplers/schedulers/vaes/upscalers/get-model/set-model/generate/sd-next)
- `search.js` — namespace: `SearchApi` (tavily/serper/serpapi/zai/searxng/koboldcpp/visit/transcript), `HordeApi`
- `content.js` — `ContentApi`: Data Bank importURL/importUUID (streams remote cards/lorebooks)

Namespace modules (multiple classes per file) are reached via the CLI 3-part form
`api <module>.<Class>.<method>` or programmatically: `await st.loadApi('media')`
returns the module namespace — then `new mod.FilesApi(st.client)`.

### UI controllers (`src/ui/`) — accessed via `UiSession`
- `session.connection` — status/isConnected/connect/disconnect/select({source, model}) — **required for generation**: a fresh headless page is `no_connection` and Generate() silently skips the LLM call; `generate()` auto-connects
- `session.chat` — read/sendUser/sendAs/sendNarrator/sendComment/deleteLast/deleteAt/cut/messages/swipe/addSwipe/deleteSwipe/newChat/renameChat/openCharacter(Name)
- `session.generation` — generate({type, forceCharacterId, quietPrompt, jsonSchema, timeout})/sendAndGenerate/gen/genRaw/ask/impersonate/continueLast/regenerate/stop
- `session.stscript` — run/runOrThrow/**invoke** (direct command callback — literal text safe)/listCommands/subscribe/pollEvents
- `session.personas` — list/active/set/create/get/update/delete/duplicate/lock/setDescriptionPlacement
- `session.groups` — list/open/addMember/removeMember/mute/unmute/moveMember/getMember/memberCount/trigger/update
- `session.settings` — read/getSampling/setSampling/getConnection/setConnection/getGenerationLimits/setGenerationLimits/getPowerUserSetting/setPowerUserSetting/setBackground/setTheme/setMessageStyle/save
- `session.state` — save/restore UI navigation context; `session.withRestoredState(fn)` runs non-destructively

## Critical ST behaviors (verified by tests — do not "fix" these)

1. **CSRF**: every POST needs `X-CSRF-Token` + session cookie from `GET /csrf-token`.
2. **Multipart uploads always use file field name `avatar`** (global multer mount).
3. **`/api/characters/create` returns plain text** (the avatar filename), not JSON.
4. **`ctx.SlashCommandParser` is the class** (static `.commands` registry, ~470 entries);
   the singleton parser with `.parse` comes from `import('/scripts/slash-commands.js')`.
5. **Must wait for APP_READY** before executing STscript — commands are registered late.
6. STscript quirks: `/add` does NOT consume the pipe implicitly (use `{{pipe}}`);
   `/incvar` takes a positional name; `/flushvar` too; `/if` `else={:…:}` must come
   BEFORE the positional then-closure; unknown commands are silently ignored unless
   strict mode; `/sys` narrator messages have `is_system=false` (only `/comment` is hidden).
7. **`amount_gen`/`max_context` are read-only ESM bindings** — set them via the slider
   DOM input event (UiSettingsControl.setGenerationLimits does this; it persists).
8. **`openGroupChat(groupId, chatId)` silently no-ops without a valid chatId** —
   use `openGroupById` to open a group (GroupControl.open handles this).
9. Group `edit` writes the WHOLE object verbatim; `chat_metadata`/`past_metadata` keys
   are stripped server-side. Muted members = `disabled_members`.
10. `persona_descriptions` entries are objects `{description, position, depth, role, lorebook, title}`.
11. **Use JSON (not multipart) for `characters.create`/`edit`** — multipart stringifies
    values and corrupts array fields (`tags`, `alternate_greetings`) and numbers. The
    endpoint accepts JSON (global bodyParser runs before multer); `CharactersApi` sends JSON.
12. **`characters.create` answers plain text** (avatar filename); `edit`/`edit-attribute`/
    `edit-avatar`/`delete` answer plain text `OK`. Cards read back report `spec: chara_card_v3`
    even when created v2-shaped (PNG writer emits both chunks, reader prefers ccv3).
13. **`validateFileName` guards only `avatar_url`** on chat routes — `file_name` is
    `sanitize`-d, so `'bad/name'` → `badname.jsonl` at HTTP 200 (no 400). `/search` reports
    `file_name` WITHOUT extension; `/get` on a missing file returns `{}`/`[]` at 200.
    `ChatsApi` rejects missing file names client-side rather than sending `undefined.jsonl`.
14. **NEVER build STscript text by string-interpolating user data.** `/send`, `/sys`,
    `/sendas`, `/comment` are `rawQuotes:true` (quotes end up IN the message); an unquoted
    `|` truncates text; leading `name=` is eaten as a named argument; and NO escaping
    scheme round-trips backslash+quote. Use `stscript.invoke(cmd, {namedArgs, text})`
    which calls the registered callback directly — text arrives byte-for-byte.
15. **A headless page starts `no_connection`** — `Generate()` assembles the prompt and
    returns WITHOUT calling the LLM (no error!). Always `connection.connect()` first
    (`generation.generate()` does this automatically). Verify generation by checking
    `chatLength` grew, not just `ok:true`.
16. **DANGER — `POST /api/backends/kobold/status` (and `/kobold/generate`) without
    `api_server` CRASHES THE ENTIRE ST SERVER PROCESS** (the handler reads
    `request.body.api_server.indexOf(...)` outside any try/catch → unhandled rejection).
    Observed live. `BackendsApi` requires `apiServer` client-side for kobold calls;
    never send a raw request without it. (text-completions `/status` answers a safe 500
    for the same omission; `/generate` answers 200 `{error:true, ...}`.)
17. **With streaming on, `ctx.generate()` resolving does NOT mean the text landed.**
    `chat[i].mes` can still be empty/flushing when the promise resolves, so a caller
    reading immediately sees an EMPTY reply. `GenerationControl.generate` therefore polls
    until `isGenerating()` is false AND the chat snapshot is stable across two rounds.
    If you read messages right after any generation, poll for non-empty text rather than
    assuming one read is final.

## Testing

```bash
npm run test:core   # HTTP client + facade + CLI (live; CLI ui tests launch a browser)
npm run test:api    # all API modules (live, fixtures auto-cleaned)
npm run test:ui     # UI modules (launches headless browser)
npm test            # everything
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ST_URL` | `http://localhost:8000` | server under test |
| `ST_DATA_ROOT` | *(unset)* | the server's `data/default-user` directory; enables filesystem-level assertions (folder auto-creation quirks, movingUI fixture sweep). Unset → those checks skip, HTTP coverage unaffected |
| `ST_BROWSER_PATH` | auto-detected Edge/Chrome | browser executable for UI tests |
| `ST_DRIVER_LIVE_GEN` | *(unset)* | `1` enables real-LLM generation tests (spends tokens, fixture chats only) |
| `ST_DRIVER_LIVE_NET` | *(unset)* | `1` enables real outbound-network tests (search visit/transcript) |

Recommended: run the suite against a **dedicated ST instance**, not the daily-driver one.
`tools/migrate-instance.mjs --from <dailyRoot> --to <testRoot>` copies config.yaml,
settings.json, secrets.json and all content (skipping regenerable backups/thumbnails/webpack
cache; `--dry` previews, `--with-backups` includes the backups).

- All tests are **live integration tests** against the running instance. Fixtures use
  the `__drvtest_` prefix and are cleaned up; settings/secrets tests save and restore state.
  `tools/purge-fixtures.js` is the safety net for anything a crashed run left behind.
- Test files run **serially** (`--test-concurrency=1`): several modules mutate shared
  server state (settings.json), and parallel files raced on save/restore.
- Per-parameter coverage: each API method and each significant parameter has its own
  `test()` case (round-trip write→read→assert, error paths, and verified server quirks).

## Docs

- `docs/API.md` — full endpoint reference with request/response shapes and verified quirks.
- `docs/STSCRIPT.md` — the live command registry (dump via `node src/cli.js ui commands`).
