# lint-engine-A

A rule-based lint engine for TypeScript source. Users define named rules
("match pattern P at locations of kind K"); the engine parses incoming
TypeScript source, evaluates every enabled rule, and emits an ordered
violation list (file, line, rule name, severity, excerpt). Rule sets and
check history are persisted in SQLite so two runs can be diffed for
added/removed violations.

## Tech stack & dependencies

| Component | Choice | Version |
|---|---|---|
| Runtime | Node.js (runs .ts directly via type stripping) | >= 22.6 (developed on v24.14.1) |
| Language | TypeScript (erasable syntax only, no build step) | — |
| HTTP | fastify (see note) | 5.0.0-local (vendored) |
| DB | SQLite via node:sqlite (built-in) | — |
| Tests | node:test (built-in) | — |

**Offline note.** This workspace has no npm registry access, so `fastify` is
vendored at `vendor/fastify` as a minimal API-compatible subset
(`get/post/put/patch/delete`, `req.params/query/body`, `reply.code().send()`,
`listen`, `setErrorHandler`) and referenced as `"fastify": "file:vendor/fastify"`.
With network access you can swap in upstream: `npm i fastify@5` — no code
changes needed. `npm install` works fully offline.

## Layout

- `src/contracts/` — shared data & error contracts (`types.ts`, `errors.ts`, `logger.ts`)
- `src/core/` — execution kernel: `parser.ts` (lightweight AST), `matcher.ts` (rule validation + matching), `engine.ts` (evaluation + ordering)
- `src/state/store.ts` — SQLite state adapter (rules, runs, violations, diff)
- `src/api/server.ts` — Fastify diagnostic interface; `src/index.ts` — service entry
- `src/config/` + `config/` — configuration layer (`engine.config.json`, `rules.seed.json`)
- `test/` — independent tests with hand-written reference answers
- `scripts/accept.mjs` — one-shot acceptance drill; `scripts/demo.mjs` — local demo

## Rule model

```json
{
  "name": "no-eval",
  "enabled": true,
  "severity": "error",            // error | warning | info
  "target": { "kind": "regex", "pattern": "\\beval\\s*\\(" },
  "message": "eval() is forbidden"
}
```

Targets:
- `{ "kind": "regex", "pattern": "..." }` — matched against whole source (multiline aware)
- `{ "kind": "node", "nodeType": "...", "pattern": "..."? }` — matched against
  lightweight AST nodes; optional `pattern` filters the node text.
  Node types: `function_declaration`, `arrow_function`, `import_statement`,
  `export_statement`, `string_literal`, `variable_declaration`,
  `class_declaration`, `interface_declaration`, `call_expression`, `comment`.

Violations are ordered by file, line, then **severity descending** at the same
position (error > warning > info), then rule name.

## Error semantics

Every failure crossing a module boundary is an `EngineError` with a stable
`category`; the HTTP layer maps it to a status. Nothing is collapsed into a
bare 200/500.

| category | HTTP | meaning | example |
|---|---|---|---|
| `INPUT_ERROR` | 400 | malformed request/rule/source | invalid regex, unknown nodeType, bad config JSON |
| `NOT_FOUND` | 404 | referenced entity missing | unknown rule or run id |
| `STATE_CONFLICT` | 409 | conflicts with persisted state | duplicate rule name |
| `RESOURCE_EXHAUSTED` | 503 | configured limit exceeded | oversized source, too many matches/files/rules |
| `COMPUTATION_FAILURE` | 500 | unexpected internal failure | — |

Error body: `{ "error": { "category": "...", "message": "...", "detail": ... } }`.

Limits are configured in `config/engine.config.json`
(`maxSourceBytes`, `maxFilesPerCheck`, `maxMatchesPerRule`, `maxRules`).

## Run logging / replay

Each `POST /check` gets a `runRef`; key intermediate states and judgement
reasons are appended as JSON lines to `logs/run-<runRef>.log`
(check.start, parse node counts, per-rule hit counts + rule message,
check.done, run.persisted). Persisted runs are replayable via
`GET /runs/:id` and comparable via `GET /diff?from=A&to=B`.

## API

- `GET /health`
- `GET /rules` · `PUT /rules` (replace set) · `POST /rules` (add one, 409 on dup)
- `PATCH /rules/:name` `{ "enabled": false }` · `DELETE /rules/:name`
- `POST /check` `{ "files": [{ "path", "content" }], "persist"?: true, "rules"?: [...] }`
  → `{ runId, violations: [{ file, line, column, rule, severity, message, excerpt, fingerprint }], ... }`
- `GET /runs` · `GET /runs/:id` · `GET /diff?from=1&to=2` → `{ added, removed }`

### Sample request

```sh
curl -X POST http://127.0.0.1:3939/check -H "content-type: application/json" -d "{\"files\":[{\"path\":\"a.ts\",\"content\":\"const x = eval('1');\n\"}]}"
```

## Reproduce from a clean checkout

```sh
npm install        # installs vendored fastify (offline-safe)
npm start          # serve on http://127.0.0.1:3939 (config/engine.config.json)
npm test           # 20 tests: matcher/parser/engine/state/api/config
npm run demo       # seeded rules, two checks, prints diff
npm run accept     # fixed-order acceptance drill; exit 0 = all pass, non-zero names the failed scenario
```

`npm run accept` executes, in order: (1) seed rules, (2) regex hit,
(3) AST node-type matching, (4) same-position severity ordering,
(5) enable/disable, (6) two-run diff, (7) error categories,
(8) resource exhaustion, (9) run history — printing request, response and
verdict per step.

## Verified results (2026-10-03, Node v24.14.1, Windows)

- `npm test` → tests 20, pass 20, fail 0
- `npm run accept` → `ACCEPTANCE: ALL 9 SCENARIOS PASSED`, exit 0
- `npm run demo` → diff run 1→2: added `no-eval@L3`, removed `no-eval@L1`, `no-todo-comment@L1`
