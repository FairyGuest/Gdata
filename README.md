# test-data-factory

Deterministic synthetic test-data factory service. Define a schema (field names,
types, constraints), and the service generates constraint-compliant synthetic
data that is **fully reproducible from a fixed seed**: the same seed always
produces the same sequence.

## Tech stack & dependencies

| Component | Choice | Notes |
|---|---|---|
| Runtime | Node.js >= 22.5 (developed on v24) | runs TypeScript natively via type-stripping, no build step |
| Language | TypeScript (erasable syntax only) | executed directly by Node |
| HTTP | Fastify 5 (declared dependency) | automatic fallback to a built-in `node:http` adapter when fastify is not installed (e.g. offline environments); identical routes and contracts |
| SQLite | `node:sqlite` (built-in `DatabaseSync`) | zero native dependencies |
| Tests | `node:test` | no external test framework |

Install (only needed if you want the Fastify backend; everything also runs without it):

```bash
npm install
```

## Commands

```bash
npm start     # start the HTTP service (PORT and DB_PATH env vars override config/default.json)
npm run demo  # local demo: generate twice from seed 42, persist to SQLite, verify
npm test      # run the independent test suite (28 tests)
npm run accept# one-shot acceptance: 12 scenarios in fixed order, exit 0 on success
```

## Architecture (module boundaries)

```
src/
  contract/schema.ts   schema parsing + constraint validation; throws typed errors
  contract/errors.ts   error taxonomy shared by all modules (FactoryError + category)
  kernel/rng.ts        seeded PRNG (mulberry32), the only randomness source
  kernel/generate.ts   recursive generator: string/integer/enum/date/object/array
  state/store.ts       SQLite adapter: datasets + run logs, seed-based re-verification
  diagnostics/runlog.ts run id + structured step log (phase, message, data)
  http/core.ts         transport-independent request handler (single source of truth)
  http/fastify-server.ts  Fastify adapter (used when fastify is installed)
  http/node-server.ts     node:http fallback adapter
  config.ts            config layer: config/default.json + PORT/DB_PATH env overrides
  server.ts            service entry point
test/                  independent tests (assert concrete values and error categories)
scripts/accept.ts      acceptance runner (npm run accept)
scripts/demo.ts        local demo (npm run demo)
```

Data flows one way: `contract` validates and normalizes raw JSON into a typed
`DatasetSchema`; `kernel` consumes only validated schemas and a seed;
`state` persists schemas/rows/run-logs and re-runs the kernel for
verification; `http` adapts transport to the core handler. All modules signal
failure exclusively through `FactoryError` with a category.

## Schema format

```json
{
  "fields": {
    "id":       { "kind": "integer", "min": 1, "max": 100 },
    "name":     { "kind": "string", "minLength": 5, "maxLength": 8, "pattern": "^[a-zA-Z0-9]+$", "charset": "abc123" },
    "role":     { "kind": "enum", "values": ["admin", "user", "guest"] },
    "birthday": { "kind": "date", "min": "1990-01-01", "max": "2000-12-31" },
    "address":  { "kind": "object", "properties": { "zip": { "kind": "string", "charset": "0123456789", "minLength": 6, "maxLength": 6 } } },
    "tags":     { "kind": "array", "minItems": 0, "maxItems": 3, "items": { "kind": "string" } }
  }
}
```

`pattern` is satisfied by rejection sampling against `charset` (default
alphanumeric); if no match is found within `maxPatternAttempts`, the request
fails as `COMPUTE_FAILURE` instead of returning invalid data.

## HTTP API

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /schemas/validate` | validate a schema, return the normalized form |
| `POST /generate` | body `{schema, seed, count}` -> `{runId, rows}` |
| `POST /datasets` | body `{name, schema, seed, count}` -> generate + persist (201) |
| `GET /datasets` / `GET /datasets/:name` | list / load persisted datasets |
| `POST /datasets/:name/verify` | regenerate from stored seed, compare byte-for-byte |
| `GET /runs/:runId` | replay the diagnostic log of a generation run |

### Example

```bash
curl -X POST http://localhost:3000/generate -H "content-type: application/json" -d "{"schema":{"fields":{"n":{"kind":"integer","min":1,"max":100}}},"seed":42,"count":3}"
```

## Error semantics

Every failure is a JSON body `{"error": {"category", "message", "details"}}`.
Nothing is silently coerced to success.

| Category | HTTP | Meaning | Examples |
|---|---|---|---|
| `INPUT_ERROR` | 400 | invalid input or conflicting constraints | `min > max`, `minLength > maxLength`, `minItems > maxItems`, date range inverted, empty enum, invalid regex, unknown kind, malformed JSON |
| `STATE_CONFLICT` | 409 / 404 | persistence state conflict | saving a dataset name that already exists (409); loading/verifying a missing dataset or run (404) |
| `RESOURCE_EXHAUSTED` | 413 | configured limit exceeded | `count > maxCount`, `maxItems > maxArrayItems`, `maxLength > maxStringLength`, nesting deeper than `maxNestingDepth` |
| `COMPUTE_FAILURE` | 500 | generation could not satisfy constraints | regex pattern unsatisfiable within `maxPatternAttempts`; unexpected internal errors |

Limits are configured in `config/default.json` (`limits` section).

## Diagnostics & replay

Every generation run gets a `runId` and a structured log (validation
decisions, row counts, abort reasons, failure category). Logs are persisted in
SQLite (`runs` table) and retrievable via `GET /runs/:runId`, so any
reported issue can be replayed with the same `seed` + `schema` + `count`.

## Testing & acceptance

- `npm test` — 28 tests across determinism, per-type constraints, nested
  recursion, constraint-conflict errors, and SQLite round-trips. Reference
  values are **frozen literals** plus an independently re-implemented
  mulberry32 in the test file, so the answer key is not produced by the kernel
  under test.
- `npm run accept` — runs 12 scenarios in fixed order (health, schema
  validation, seed determinism, constraint checks, nested generation, conflict
  400, duplicate 409, seed re-verification, resource 413, compute failure 500,
  run-log replay, missing dataset 404), printing request/response/verdict per
  step. Exits 0 when all pass, non-zero otherwise naming the failed scenario.

### Reproduce from a clean checkout

```bash
node --version   # >= 22.5
npm install      # optional: enables the Fastify backend
npm test         # expect: 28 pass, 0 fail
npm run accept   # expect: ALL 12 SCENARIOS PASSED, exit code 0
npm run demo     # expect: identical = true, verify: true
```

Last verified on Node v24.14.1: 28/28 tests pass, 12/12 acceptance scenarios
pass (exit 0).
