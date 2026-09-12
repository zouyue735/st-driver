# SillyTavern 1.18.0 API Reference (driver-oriented)

Every route below was verified against the ST source (`src/endpoints/*.js`,
mount table in `src/server-startup.js`) and/or by live integration tests in
this repo. Unless noted, all endpoints are `POST` with a JSON body, need the
CSRF header + session cookie (handled by `STClient`), and answer JSON.

## Authentication

| Step | Detail |
|---|---|
| Handshake | `GET /csrf-token` → `{token}` + `Set-Cookie: session-<hash>=...` |
| Every request | header `X-CSRF-Token: <token>`, replay session cookie |
| Health | `POST /api/ping` → 204 (needs CSRF header!) |
| Version | `GET /version` → `{pkgVersion, agent, gitRevision, gitBranch}` (no auth) |
| Multipart | file field is ALWAYS `avatar` (global `multer.single('avatar')` mount) |
| Filename guard | body fields `avatar_url/id/avatar/bg/name/file_name/overwrite_name` are rejected (400) if they contain `/`, `\` or NUL |

## Characters — `/api/characters/*` (driver: `CharactersApi`)

| Route | Body | Response |
|---|---|---|
| `/all` | `{}` | array of cards (v1 wrapper: `name, description, ..., avatar, data{v2}, chat, json_data, date_added, create_date, chat_size, date_last_chat`; shallow mode when lazyLoad enabled) |
| `/get` | `{avatar_url}` | single full card; 404 if missing |
| `/create` | JSON (or multipart): `ch_name` (required), `description, personality, scenario, first_mes, mes_example, creator_notes, talkativeness, fav('true'/'false'), tags[], creator, character_version, system_prompt, post_history_instructions, alternate_greetings[], world, depth_prompt_prompt, depth_prompt_depth, depth_prompt_role, extensions(JSON string), file_name`; multipart adds file `avatar` + query `?crop=<json>` | **plain text**: avatar filename |
| `/edit` | same fields as create + `avatar_url` (required), `ch_name` (required), `chat`, `create_date` | plain text `OK` |
| `/edit-avatar` | multipart: `avatar_url` + file `avatar` (required) | plain text `OK` |
| `/edit-attribute` | `{avatar_url, ch_name, field, value}` — field must exist on the card, not `json_data` | plain text `OK` |
| `/merge-attributes` | single: `{avatar, ...fields}` / bulk: `{avatars:[] (empty=all), data, filter?{path}}`; sentinel `"__@@UNSET@@__"` deletes a key | plain text `OK` or `{updated[], skipped[], failed[]}` |
| `/delete` | `{avatar_url, delete_chats?}` | 200 |
| `/rename` | `{avatar_url, new_name}` | `{avatar}` |
| `/duplicate` | `{avatar_url}` | `{path}` (`_N` suffix auto-increment) |
| `/chats` | `{avatar_url, simple?, metadata?}` | array of `{file_id, file_name, file_size, chat_items, mes, last_mes, chat_metadata?}`; `{error:true}` when no chat dir (HTTP 200!) |
| `/export` | `{avatar_url, format:'png'\|'json'}` | png: binary attachment; json: V2 card |
| `/import` | **multipart** file `avatar` + `{file_type:'yaml\|yml\|json\|png\|charx\|byaf', preserved_name?}` | `{file_name}` |

**Use JSON, not multipart, for `/create` and `/edit`** (the driver does this).
Multipart stringifies every value, which corrupts arrays (`tags`,
`alternate_greetings`) and numbers (`talkativeness`, `depth_prompt_depth`): a
JSON-stringified array field comes back as a one-element array containing the
raw JSON string. The endpoint accepts `application/json` because the global
`bodyParser.json` runs before multer, and the frontend's own `/char-create`
slash command sends JSON too.

**Card spec version quirk**: on 1.18.0 cards read back via `get`/`all`/`export`
report `spec: 'chara_card_v3'` / `spec_version: '3.0'` even when created from
v2-shaped data — the PNG writer emits both a `chara` (v2) and a `ccv3` chunk and
the reader prefers ccv3. The payload structure is still the classic v2 shape.

Character Card V2 fields: `name` (only required one), `description, personality,
scenario, first_mes, mes_example, creator_notes, system_prompt,
post_history_instructions, alternate_greetings[], tags[], creator,
character_version, character_book, extensions{}`.
ST-specific `extensions` keys: `talkativeness(0-1), fav, world, depth_prompt{prompt,depth,role}, regex_scripts[]`.

## Chats — `/api/chats/*` (driver: `ChatsApi`)

JSONL files. Line 0 = header `{chat_metadata:{}, user_name:'unused', character_name:'unused'}`.
Message object: `{name, is_user, is_system, send_date, mes, extra{}, force_avatar?, swipes?[], swipe_info?[], swipe_id?, gen_started?, gen_finished?}`.

| Route | Body | Response |
|---|---|---|
| `/save` | `{avatar_url, file_name (no .jsonl), chat:[header,...msgs], force?}` | `{ok:true}`; `400 {error:'integrity'}` on mismatch |
| `/get` | `{avatar_url, file_name}` | parsed JSONL array |
| `/rename` | `{avatar_url, original_file, renamed_file, is_group?}` | `{ok, sanitizedFileName}` |
| `/delete` | `{avatar_url, chatfile}` (.jsonl appended) | `{ok:true}` |
| `/export` | `{file, avatar_url (unless group), is_group?, format?='jsonl', exportfilename?}` | `{message, result}` (raw JSONL or transcript text) |
| `/import` | **multipart** file + `{file_type:'json\|jsonl', avatar_url, character_name?, user_name?}` — JSON autodetects Kobold Lite / CAI / oobabooga / Agnai / RisuAI / Chub | `{res:true, fileNames[]}` |
| `/search` | `{query?, avatar_url \| group_id}` | `[{file_name, file_size, message_count, last_mes, preview_message}]` |
| `/recent` | `{pinned?, max?, metadata?}` | `getChatInfo[]` + `avatar` or `group` per item |
| `/group/get` | `{id: chatId}` | message array; missing chat → `[]` (200!) |
| `/group/save` | `{id, chat:[...], force?}` | `{ok:true}` |
| `/group/info` | `{id}` | `getChatInfo` (chat_items excludes header) |
| `/group/delete` | `{id}` | `{ok:true}`; missing → 400 |
| `/group/import` | **multipart** file | `{res:'<newchatname>'}` |

Chats quirks (verified live):
- The `validateFileName` middleware guards **`avatar_url` only** — `file_name`
  goes through `sanitize-filename`, so `'bad/name'` is silently stored as
  `badname.jsonl` with HTTP 200 (no 400).
- `/save` and `/get` always append `.jsonl`; `/rename` does NOT append it to
  `renamed_file` (renaming to a bare name yields an unlistable file); `/export`
  expects the extension. `ChatsApi` normalizes all of this and rejects missing
  file names client-side instead of sending `undefined.jsonl`.
- `/search` reports `file_name` WITHOUT the extension (it is the `file_id`),
  unlike `/api/characters/chats` which includes it.
- `/get` on a missing file/dir answers `{}` or `[]` with HTTP 200, not 404.

## Groups — `/api/groups/*` (driver: `GroupsApi`)

Group JSON (file `<id>.json`, `id = String(Date.now())` at creation):
`id, name, members[](avatar filenames), avatar_url?, allow_self_responses,
activation_strategy (0=NATURAL,1=LIST,2=MANUAL,3=POOLED), generation_mode
(0=SWAP,1=APPEND,2=APPEND_DISABLED), disabled_members[] (= "muted"), fav,
chat_id, chats[], auto_mode_delay(5), generation_mode_join_prefix/suffix,
hideMutedSprites`.
Quirks: `create` drops `fav`/`avatar_url` when undefined; `edit` writes the
body verbatim and strips `chat_metadata`/`past_metadata`; `delete` returns
`{ok:true}` even for unknown ids. Fields like `group_only_persona`,
`muted_members`, `generate_until` do NOT exist in 1.18.

| Route | Body | Response |
|---|---|---|
| `/all` | ignored | groups + `date_added, create_date, chat_size, date_last_chat` |
| `/create` | group fields (no id) | full saved group object |
| `/edit` | `{id, ...complete group}` | `{ok:true}` |
| `/delete` | `{id}` (cascades chats) | `{ok:true}` |

## World Info — `/api/worldinfo/*` (driver: `WorldInfoApi`)

| Route | Body | Response |
|---|---|---|
| `/list` | ignored | `[{file_id, name, extensions}]` |
| `/get` | `{name}` | `{entries:{uid→entry}}`; missing world → `{entries:{}}` (200) |
| `/edit` | `{name, data:{entries}}` — also creates new worlds | `{ok:true}` |
| `/delete` | `{name}` | 200; missing file → **500** |
| `/import` | **multipart** file (JSON with `entries`) or `{convertedData:'<json string>'}` (file still required) | `{name}` |

Entry fields (all round-trip verified): `uid, key[], keysecondary[], comment,
content, constant, vectorized, selective, selectiveLogic(0=AND ANY,1=NOT ALL,
2=NOT ANY,3=AND ALL), addMemo, order(100), position(0=before,1=after,2=ANTop,
3=ANBottom,4=atDepth,5=EMTop,6=EMBottom,7=outlet), disable, ignoreBudget,
excludeRecursion, preventRecursion, delayUntilRecursion,
match{Persona,Character}Description, matchCharacterPersonality,
matchCharacterDepthPrompt, matchScenario, matchCreatorNotes, probability(100),
useProbability, depth(4), outletName, group, groupOverride, groupWeight(100),
scanDepth, caseSensitive, matchWholeWords, useGroupScoring, automationId,
role(0=system,1=user,2=assistant), sticky, cooldown, delay,
characterFilterNames[], characterFilterTags[], characterFilterExclude,
triggers[]`.

## Settings — `/api/settings/*` (driver: `SettingsApi`)

| Route | Body | Response |
|---|---|---|
| `/get` | ignored | `{settings:'<JSON string>', world_names[], themes[], movingUIPresets[], quickReplyPresets[], instruct[], context[], sysprompt[], reasoning[], koboldai_settings[], openai_settings[], novelai_settings[], textgenerationwebui_presets[], enable_extensions, request_compression}` |
| `/save` | whole settings object (verbatim write) | `{result:'ok'}` |
| `/get-snapshots` | ignored | `[{date,name,size}]` |
| `/make-snapshot` | ignored | 204 |
| `/load-snapshot` | `{name}` (must start `settings_<handle>_`) | raw settings JSON string |
| `/restore-snapshot` | `{name}` | 204 |

Top-level settings keys: `firstRun, accountStorage, currentVersion, username,
active_character, active_group, user_avatar, amount_gen, max_context, main_api,
world_info_settings, swipes, horde_settings, power_user, extension_settings,
tags, tag_map, nai_settings, kai_settings, oai_settings, background, proxies,
selected_proxy`.

## Presets — `/api/presets/*` (driver: `PresetsApi`)

`apiId` ∈ `kobold | koboldhorde | novel | textgenerationwebui | openai |
instruct | context | sysprompt | reasoning`.

| Route | Body | Response |
|---|---|---|
| `/save` | `{name, preset, apiId}` | `{name}`; missing name → **500** |
| `/delete` | `{name, apiId}` | 200/404 |
| `/restore` | `{name, apiId}` | `{isDefault, preset}` — non-default presets return `{isDefault:false, preset:{}}` (factory-default lookup only) |

## Secrets — `/api/secrets/*` (driver: `SecretsApi`)

| Route | Body | Response |
|---|---|---|
| `/write` | `{key, value, label?}` | `{id}`; deactivates siblings |
| `/read` | ignored | `{<key>: [{id, value(masked), label, active}]\|null}` |
| `/view` | ignored | raw values — requires `allowKeysExposure:true` in config, else 403 |
| `/find` | `{key, id?}` | `{value}`; 403 unless exposure enabled OR key ∈ EXPORTABLE (`libre_url, lingva_url, oneringtranslator_url, deeplx_url`) |
| `/delete` | `{key, id?}` | 204 |
| `/rotate` | `{key, id}` | 204 |
| `/rename` | `{key, id, label}` | 204 |
| `/settings` | ignored | `{allowKeysExposure}` |

## Tokenizers — `/api/tokenizers/*` (driver: `TokenizersApi`)

- `/<model>/encode` `{text}` → `{ids, count, chunks}`; `/<model>/decode` `{ids}` → `{text}`.
  Models: `llama, llama3, nerdstash, nerdstash_v2, mistral, yi, gemma, jamba,
  gpt2, claude, qwen2, command-r, command-a, nemo, deepseek`.
- `/openai/encode|decode|count` — model via **query** `?model=`; count body is a messages array → `{token_count}`.
- `/remote/kobold/count` `{text,url}`, `/remote/textgenerationwebui/encode` `{text,url,model?,api_type?}` → `{error:true}` (200) when the remote is down.
- Quirk: **llama & mistral decode drops spaces** (server decodes per-id and concatenates).

## Personas (avatars + settings) — driver: `PersonasApi` / UI `session.personas`

- Files: `POST /api/avatars/get` → filenames; `/api/avatars/upload` multipart
  (`overwrite_name?` body, `crop` via **query**) → `{path}`; `/api/avatars/delete` `{avatar}`.
- Metadata lives in settings: `user_avatar` (active), `power_user.personas`
  (avatarFile→name), `power_user.persona_descriptions` (avatarFile→
  `{description, position, depth, role, lorebook, title}`),
  `power_user.default_persona`. Position: 0=story string, 2=top AN, 3=bottom
  AN, 4=at depth, 9=none.
- Account: `GET /api/users/me` → `{handle:'default-user', name:'User', avatar(dataURI), admin:true, password:false, created}` (single-user mode).

## Media & files

| Module | Routes |
|---|---|
| Backgrounds | `/all` → `{images:[{filename,isAnimated}], config}`; `/folders`; `/upload` (multipart → plain-text filename); `/rename {old_bg,new_bg}`; `/delete {bg}` |
| Sprites | `GET /api/sprites/get?name=<char>`; `/upload` multipart `{name,label,spriteName?}`; `/upload-zip` multipart `{name}`; `/delete {name,label?,spriteName?}` |
| Images | `/upload` **JSON** `{image:base64, format, filename?, ch_name?}`; `/list/:folder?`; `/folders`; `/delete {path}` |
| Files (Data Bank) | `/sanitize-filename {fileName}`; `/upload {name, data:base64}`; `/delete {path}`; `/verify {urls}` |
| Image metadata | `/folders/get|create|update|delete|assign|unassign|set-thumbnails`; `/` single/multi metadata; `/all {prefix?}`; `/cleanup` |
| Assets | `/get` (by category); `/download {url,category,filename}`; `/delete {category,filename}`; `GET /character?name=&category=` |
| Themes / MovingUI / QuickReplies | `/save` (body must include `name`; written verbatim), `/delete {name}` |

Media quirks (verified live; full list in MediaApi/FilesApi/ImageMetadataApi JSDoc):
- `files/sanitize-filename` with a MISSING `fileName` answers `{fileName:'undefined'}`
  (`String(undefined)` is truthy); an EMPTY string answers 400. `files/upload` restricts
  names to `[a-zA-Z0-9_\-.]`, rejects unsafe extensions and leading `.`, else 400.
  `files/verify` silently SKIPS urls outside `user/files`.
- `images/upload` needs PURE base64 in `image` (a data URI is NOT stripped and corrupts the
  file); `format` is a MEDIA_EXTENSION without the dot; `fileName` keeps only its base.
- `images/list` CREATES a missing folder and answers `[]`.
- image-metadata root POST: single `{path}` outside the data dir → 500; batch `{paths}` with a
  bad path → an `{error}` entry in an HTTP 200 map. `folders/assign` only accepts `backgrounds/...`
  relative paths (else 500). `all({prefix})` omits the `folders` key. `assets/get` excludes 'temp';
  'vrm' is `{model[],animation[]}` while other categories are flat arrays.

## Vectors — `/api/vector/*` (driver: `VectorsApi`)

`/insert {collectionId, items:[{hash,text,index}], source?}`; `/list {collectionId}`;
`/query {collectionId, searchText, topK=10, threshold=0, source='transformers'}` →
`{hashes[], metadata[]}`; `/query-multi {collectionIds[]}`; `/delete {collectionId, hashes[]}`;
`/purge {collectionId}`; `/purge-all`.

Verified pitfalls (all recorded in VectorsApi JSDoc):
- **Omitting `source` creates a literal `'undefined'` collection** (`String(req.body.source) || 'transformers'`
  turns missing into the string 'undefined' before the fallback) — insert 500s and leaves
  `vectors/undefined/` garbage. The wrapper always sends `source` explicitly.
- `query`'s `threshold` filters only `metadata`, not `hashes` (query-multi filters both).
- `list`/`query` on an unknown collectionId **silently creates an empty index dir** (200, not 404).
- `delete` matches hashes with strict numeric `$in` — string hashes insert but never delete.

## Maintenance

- Stats `/api/stats/get|recreate|update` — get returns `{timestamp, ...}`; recreate/update
  rewrite user stats (implemented, mutation tests skipped by design); success is plain text `OK`.
- Backups `/api/backups/chat/get|delete|download` — `name` must start with `chat_` and
  delete/download check `fs.existsSync`, so the FULL file name (with `.jsonl`) is required;
  a missing `name` answers **500** (sanitize-filename throws on undefined), so the wrapper
  validates client-side. Chat saves auto-create backups here — `tools/purge-fixtures.js`
  sweeps `*drvtest*` ones.
- Data Maid `/api/data-maid/report` → `{report, token}` (slow: parses every chat); a NEW
  report invalidates ALL previous tokens for the user; `/finalize {token}` → 204;
  `GET /view?token=&hash=`; `/delete {token, hashes[]}` (destructive — wrapper exposes,
  tests only exercise invalid-token error paths). Error bodies are plain text, not JSON.
- Extensions `GET /api/extensions/discover` → `[{type:'system'|'local'|'global', name}]`;
  `/version|branches|update|switch|move|delete` operate on **third-party installs only** —
  system extension names (regex, quick-reply) 404 on the git routes (verified in source).
  `/install {url}` clones and executes third-party code: deliberately NOT wrapped.
## Content (Data Bank remote import) — `/api/content/*` (driver: `ContentApi`)

Both endpoints DOWNLOAD from an external provider and stream the file back —
the server writes nothing to disk; the caller feeds the bytes into
`CharactersApi.importCard` / `WorldInfoApi.import` afterwards.

| Route | Body | Response |
|---|---|---|
| `/importURL` | `{url}` a full content URL | file bytes + `Content-Disposition: attachment; filename=...`, `Content-Type`, **`X-Custom-Content-Type: character\|lorebook`** |
| `/importUUID` | `{url}` — despite the field name this is the raw **UUID/slug**, not a URL | same |

Whitelisted providers (verified in `content-manager.js`): chub.ai /
characterhub.org, janitorai.com, pygmalion.chat, aicharactercards.com,
realm.risuai.net, perchance.org, plus generic hosts in the server config key
`whitelistImportDomains`.

`importUUID` slug shapes: `<uuid>_character` (Janitor), bare 36-char UUID
(Pygmalion), `AICC/<author>/<card>`, Perchance slug, else Chub.

Error semantics: missing/empty `url` → **400**; non-whitelisted or unparseable
host → **404** (`getHostFromUrl` returns `''` for a malformed URL, matching
nothing); provider fetch/parse failure → **500**. `ContentApi` returns
`{buffer, contentType, fileName, mimeType, headers}`; url validation is left to
the server so its descriptive 400 stays observable. The driver's tests exercise
only validation/error paths — no external host is ever fetched.

## Backends (LLM proxy) — `/api/backends/*` (driver: `BackendsApi`)

- `chat-completions/status` `{chat_completion_source, secret_id?, reverse_proxy?, proxy_password?, custom_url?, azure_*?, ...}` → provider model list.
- `chat-completions/generate` — universal body: `chat_completion_source, messages[{role,content}], model, temperature, top_p, top_k, max_tokens, presence_penalty, frequency_penalty, seed, n, stop[], logit_bias, stream, tools, tool_choice, json_schema{name,strict?,value}, min_p, top_a, repetition_penalty, include_reasoning, reasoning_effort, reverse_proxy, proxy_password, secret_id, custom_url, custom_include_body/headers (YAML), assistant_prefill, ...` → passthrough provider response. **NOTE**: this bypasses ST's prompt pipeline — for "as the UI does it" generation use the UI track (`session.generation`).
- `chat-completions/bias` — body is an ARRAY `[{text,value}]` + query `?model=` → logit-bias map.
- `chat-completions/process` `{messages, type}` → `{messages}`.
- `text-completions/status|generate|props`, `kobold/status|generate|embed|transcribe-audio`.
- Sources: `openai, claude, openrouter, ai21, makersuite, vertexai, mistralai, custom, cohere, perplexity, groq, chutes, electronhub, nanogpt, deepseek, aimlapi, xai, pollinations, moonshot, fireworks, cometapi, azure_openai, zai, siliconflow, minimax, workers_ai`.

## External-AI extras (drivers: `TranslateApi`/`CaptionApi`/`ClassifyApi`/`SpeechApi` in `external-ai.js`)

- Translate `/api/translate/<libre|google|yandex|lingva|deepl|onering|deeplx|bing>` `{text, lang}` → **plain text**.
  `lang` is the TARGET code; `zh-CN` is normalized to `zh` server-side (libre). Most providers need a
  configured secret (libre_url, deepl key, …) or answer an error.
- Caption `/api/extra/caption/` `{image: url|dataURI, prompt?}` → `{caption}` (vision source or local
  transformers image-to-text). Classify `/api/extra/classify/labels` → `{labels[]}`; `/` `{text}` →
  `{classification:[{label, score}]}` (top-5, sorted; local extras model).
- Speech `/api/speech/recognize {model, audio(base64 dataURI), lang?}` → `{text}`;
  `/synthesize {text, model?, speaker?}` → **WAV binary** (local extras TTS).

## Stable Diffusion — `/api/sd/*` (driver: `StableDiffusionApi`)

Thin proxy to an SD WebUI / SD.Next / ComfyUI backend. **Every** call carries `{url, auth?}` (auth =
`'user:pass'` basic). Only these 10 routes exist in 1.18.0 (verified — the `/sizes` and `/workflows`
routes some older docs mention are NOT present):
`/ping`, `/models`, `/samplers`, `/schedulers`, `/vaes`, `/upscalers`, `/sd-next/upscalers`,
`/get-model`, `/set-model {url, auth?, model}`, `/generate` (forwards the A1111 txt2img payload
verbatim + url/auth). Without a reachable backend, `/ping` answers **500** (handler throws).

## Search & Horde (drivers: `SearchApi` / `HordeApi` in `search.js`)

- Search `/api/search/*`: `tavily {query, include_images?}`, `serper {query, images?}`,
  `serpapi {query}`, `zai {query}` — these answer **400 when no secret is configured** (verified).
  `searxng {baseUrl, query, preferences?, categories?}`, `koboldcpp {query, url}` need a running
  instance. `visit {url, html?}` and `transcript {id, lang?, json?}` make real outbound calls.
- Horde `/api/horde/*`: anonymous `status` / `text-models` / `text-workers` / `sd-models` /
  `sd-samplers`; `user-info` reads the `api_key_horde` secret; `generate-text` / `generate-image
  {prompt}` submit Kudos-spending jobs (poll `task-status {taskId}`, `cancel-task {taskId}`);
  `caption-image {image}`.
- Provider-specific TTS/image/video proxies live under `/api/openai`, `/api/google`, `/api/anthropic`,
  `/api/azure`, `/api/volcengine`, `/api/minimax`, `/api/novelai`, `/api/openrouter`, `/api/nanogpt`
  (not wrapped — use the `raw` CLI track or STClient directly if needed).

## Frontend-only capabilities (UI track)

No server endpoint exists for these — they run in the browser page:

| Capability | Driver entry |
|---|---|
| API connection (prerequisite for generation!) | `session.connection.connect/status/select` — headless pages start `no_connection` and `Generate()` silently skips the LLM |
| Full generation pipeline (prompt assembly + WI + AN + regex) | `session.generation.generate/sendAndGenerate` (`ctx.generate(type, {force_chid,...})`; auto-connects) |
| STscript (~470 commands incl. extensions) | `session.stscript.run` (parsed script) / `session.stscript.invoke` (direct callback — literal text safe) |
| Persona live switching | `session.personas.set` (`/persona-set`, `setUserAvatar`) |
| Group member trigger | `session.groups.trigger` (`/trigger`) |
| Swipes UI | `session.chat.swipe/addSwipe/deleteSwipe` |
| Events | `session.stscript.subscribe/pollEvents` (`ctx.eventSource`) |
| Live sampling edits | `session.settings.setSampling` (mutates `oai_settings`) |
| Response length / context sliders | `session.settings.setGenerationLimits` (DOM input events — ESM bindings are read-only) |
| UI navigation state guard | `session.state.save/restore`, `session.withRestoredState(fn)` |

Key STscript gotchas (all verified): see SKILL.md "Critical ST behaviors".
