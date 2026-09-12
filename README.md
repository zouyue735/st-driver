# st-driver

A modular, test-driven driver that lets agents fully control a running
[SillyTavern](https://github.com/SillyTavern/SillyTavern) instance (verified
against 1.18.0). Built as a Cherry Studio agent skill — see `SKILL.md` for the
agent-facing instructions.

## Two tracks

- **HTTP API** (`src/api/*`) — every `/api/*` endpoint with typed wrappers:
  characters, chats, groups, world info, settings, presets, secrets,
  tokenizers, personas, backgrounds, sprites, images, files, vectors,
  extensions, backends, and more.
- **UI / Playwright** (`src/ui/*`) — the frontend-only capabilities: the full
  generation pipeline, all ~470 STscript slash commands, persona switching,
  group triggers, swipes, live settings, event subscriptions.

## Layout

```
src/
  core/     client.js (CSRF+cookie HTTP), browser.js (Edge/Chrome launch), stscript.js
  api/      HTTP endpoint modules (one class per domain)
  ui/       session.js facade + chat/generation/personas/groups/settings/state
  cli.js    one-shot command entry: node src/cli.js {api|ui|raw|list} ...
  index.js  createStDriver() / createUiDriver()
tests/      live integration tests (node:test, serial, __drvtest_ fixtures)
docs/       API.md (endpoint reference), STSCRIPT.md (live command registry)
```

## Requirements

- SillyTavern running at `http://localhost:8000` (override: `ST_URL`)
- Node.js >= 20; system Edge or Chrome for the UI track (override: `ST_BROWSER_PATH`)
- `npm install` once in this directory

## Test

```bash
npm test          # everything, live against the running instance
npm run test:api  # HTTP modules only
npm run test:ui   # browser modules only
```

The suite is live: it talks to a running server and launches a real browser.
Point it at a **dedicated** instance rather than your daily-driver one —
`tools/migrate-instance.mjs --from <dailyRoot> --to <testRoot>` copies the
config, API keys, model/prompt settings and content over.

| Variable | Purpose |
|---|---|
| `ST_URL` | server under test (default `http://localhost:8000`) |
| `ST_DATA_ROOT` | server's `data/default-user`; enables filesystem-level assertions |
| `ST_BROWSER_PATH` | browser executable override |
| `ST_DRIVER_LIVE_GEN=1` | enable real-LLM generation tests (spends tokens) |
| `ST_DRIVER_LIVE_NET=1` | enable real outbound-network tests |

Every command and every significant parameter has its own test case; the suite
is the specification. Server-behavior quirks discovered by testing are recorded
in `SKILL.md` ("Critical ST behaviors") and inline comments.

## License / provenance

Independent implementation. SillyTavern is AGPL-3.0; this driver talks to it
over its HTTP API and browser DOM like any other client and contains no
SillyTavern source code.
