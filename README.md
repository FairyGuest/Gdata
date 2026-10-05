# lint-engine-b

A rule-based lint engine for TypeScript source. Users register a named rule set
(each rule says *where* to match and *what pattern* to match), the engine scans
input TypeScript source, evaluates every enabled rule, and returns a violation
list (file, line, rule name, severity, snippet). Rule sets and check history are
persisted in SQLite, and two check runs can be diffed for added/removed violations.

## Requirements

- Node.js >= 22.6 (developed and verified on Node v24.14.1, Windows)
- No npm dependencies. The engine uses only the standard library:
  TypeScript is executed via Node's native type stripping, SQLite via the
  built-in `node:sqlite` module, HTTP via `node:http`.

> Note on stack: the target stack was TypeScript + Node.js + Fastify + SQLite.
> The build/accept environment has no network access, so Fastify could not be
> installed. The HTTP layer (`src/api/server.ts`) is a minimal Fastify-style
> router (method + path-pattern + JSON error mapping) over `node:http`;
> swapping in Fastify later only means replacing that one adapter file.
> SQLite is provided by `node:sqlite` (built into Node >= 22).

## Layout (engineering boundaries)

- `src/contracts/` — data and error contracts shared by all modules
  - `types.ts`: `Rule`, `Violation`, `CheckResult`, `DiffResult`, severity ranks
  - `errors.ts`: `EngineError` with a category (see Error semantics)
- `src/core/` — execution kernel
  - `scanner.ts`: AST-lite scanner (`FunctionDeclaration`, `ImportStatement`, `StringLiteral`)
  - `engine.ts`: rule validation, check execution, severity ordering, run log
- `src/state/` — state adapter
  - `store.ts`: SQLite persistence for rules, runs, violations; run diffing
- `src/api/` — diagnostics interface
  - `server.ts`: HTTP routes, JSON error mapping
- `src/config.ts` — configuration layer (env-driven limits, port, db path)
- `src/index.ts` — service entry point
- `test/` — independent tests (node:test, in-process)
- `scripts/demo.ts` — local end-to-end demo
- `scripts/accept.ts` — one-shot acceptance drill (`npm run accept`)

## Rule model

```json
{
  "name": "no-eval",
  "enabled": true,
  "severity": "error",
  "message": "eval() is forbidden",
  "match": { "kind": "regex", "pattern": "eval\(" }
}
```

`match` is one of:

- `{ "kind": "regex", "pattern": "...", "flags?": "i" }` — every regex match in
  the source becomes a violation.
- `{ "kind": "ast", "nodeType": "FunctionDeclaration" | "ImportStatement" | "StringLiteral", "pattern?": "..." }`
  — every scanned AST-lite node of that type (optionally filtered by `pattern`
  applied to the node text) becomes a violation.

Violations are sorted by `(line, column, severity desc, rule name)`, so multiple
rules hitting the same position are ordered error > warning > info.

## Commands

```sh
npm start     # start the HTTP service (default port 8787, db lint-engine.db)
npm run demo  # self-contained demo: rules -> check -> check -> diff
npm test      # run the independent test suite (15 tests)
npm run accept  # one-shot acceptance drill, exit 0 on success, non-zero on failure
```

Configuration via environment: `LINT_PORT`, `LINT_DB`,
`LINT_MAX_SOURCE_BYTES`, `LINT_MAX_RULES`, `LINT_MAX_MATCHES_PER_RULE`.

## HTTP API

- `GET /health`
- `GET /rules` — list the active rule set
- `PUT /rules` — replace the rule set: `{ "rules": [ ... ] }`
- `POST /rules` — add one rule: `{ "rule": { ... } }` (409 on duplicate name)
- `PATCH /rules/:name` — `{ "enabled": false }` to disable/enable
- `POST /check` — `{ "file": "a.ts", "source": "..." }` -> `{ runId, violations, log }`
- `GET /runs/:id` — stored run with violations and engine log
- `GET /diff?from=<runId>&to=<runId>` — `{ added, removed }` violations

### Sample session

```sh
curl -X PUT localhost:8787/rules -H 'content-type: application/json' -d '{"rules":[{"name":"no-eval","enabled":true,"severity":"error","message":"no eval","match":{"kind":"regex","pattern":"eval\("}}]}'
curl -X POST localhost:8787/check -H 'content-type: application/json' -d '{"file":"a.ts","source":"eval("1");
"}'
curl 'localhost:8787/diff?from=<runId1>&to=<runId2>'
```

## Error semantics

All failures are reported as `EngineError` with a **category** and a machine
readable **code**; the HTTP layer maps categories to status codes. Nothing is
silently swallowed and unknown states are never reported as success.

| Category | HTTP | Meaning | Example codes |
|---|---|---|---|
| `INPUT_ERROR` | 400 | malformed request/rule/source args | `RULE_REGEX_INVALID`, `CHECK_ARGS_INVALID`, `BODY_NOT_JSON` |
| `STATE_CONFLICT` | 409 | conflicting persistent state | `RULE_DUPLICATE`, `RULE_EXISTS` |
| `NOT_FOUND` | 404 | referenced entity missing | `RULE_NOT_FOUND`, `RUN_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| `RESOURCE_EXHAUSTED` | 413 | configured limits exceeded | `SOURCE_TOO_LARGE`, `TOO_MANY_RULES`, `TOO_MANY_MATCHES` |
| `COMPUTATION_ERROR` | 500 | unexpected runtime failure | `REGEX_EXEC_FAILED`, `INTERNAL` |

Error body shape: `{ "error": { "category", "code", "message" } }`.

## Run log / replay

Every check produces a `runId` and a structured log (rules loaded, per-rule
match counts, sort step, final count) which is persisted with the run.
`GET /runs/:id` returns it, so any check can be replayed/audited after the fact.

## Reproduction from a clean directory

1. Install Node >= 22.6 (verified: v24.14.1). No `npm install` needed — zero dependencies.
2. `npm test` — runs 15 tests asserting concrete positions, severities, diff
   results and error categories (expected values are hand-written, not derived
   from the engine).
3. `npm run accept` — drills all scenarios in fixed order (rule registration,
   regex hit, AST node match, same-position severity ordering, run diff,
   disable, four error categories, run-log persistence), printing each request,
   response and verdict. Exits 0 when all 11 steps pass, non-zero otherwise.
4. `npm start` + the curl samples above for manual exploration.

## Verified results (2026-10-05, Node v24.14.1, Windows)

- `npm test`: 15/15 pass
- `npm run accept`: 11/11 steps pass, exit code 0
- `npm run demo`: runs to completion, prints diff output

