# flaky-detector

A flaky-test detection service. It runs the same test N times, classifies it
as stable (all pass / all fail) or flaky (mixed outcomes), computes a
confidence score and a suggested retry count, and persists every detection
round in SQLite so flaky trends can be queried across rounds by test name.

## Requirements

- Node.js >= 24 (runs TypeScript directly via native type stripping; uses the
  built-in `node:sqlite` driver and `node:test` runner)
- No runtime dependencies. `npm install` is only needed for the optional
  typecheck (devDependencies: typescript 5.8.3, @types/node 24.0.15).

## Quick start (from a clean checkout)

```bash
npm test          # unit tests (node:test, real assertions, prints results)
npm run accept    # one-shot acceptance drill: boots the service, walks all
                  # scenarios in fixed order, exit 0 on success / 1 on failure
npm run demo      # local demo: 3 canonical patterns + cross-round trend
npm start         # start the HTTP service (default port 4300)
npm run typecheck # optional: tsc --noEmit (needs npm install first)
```

## Configuration (environment variables)

| Variable                  | Default        | Meaning                                  |
|---------------------------|----------------|------------------------------------------|
| FLAKY_PORT                | 4300           | HTTP listen port                         |
| FLAKY_DB_PATH             | data/flaky.db  | SQLite file path (`:memory:` allowed)  |
| FLAKY_DEFAULT_RUNS        | 5              | runs per round when `runs` is omitted  |
| FLAKY_MAX_RUNS            | 100            | run budget per round (RESOURCE_EXHAUSTED)|
| FLAKY_TARGET_RELIABILITY  | 0.99           | reliability target for retry suggestion  |
| FLAKY_MAX_RETRIES         | 5              | cap for suggested retries                |

## API

### POST /detections
Runs a detection round.

```bash
curl -X POST http://127.0.0.1:4300/detections \
  -H 'content-type: application/json' \
  -d '{"testName":"login-test","pattern":"alternate","runs":6}'
```

`pattern` selects a built-in executor: `always-pass`, `always-fail`,
`alternate` (odd runs pass / even runs fail), `slow-pass` (20ms per run,
for concurrency tests), `broken-executor` (violates the executor contract).
Real adapters implement the same `TestExecutor` contract
`(runIndex) => 'pass' | 'fail'`.

Response 200:
```json
{
  "report": {
    "testName": "login-test",
    "roundId": "…uuid…",
    "totalRuns": 6,
    "classification": "flaky",
    "confidence": 0.9844,
    "distribution": { "passes": 3, "failures": 3 },
    "firstFailureRun": 2,
    "suggestedRetries": 5,
    "reasoning": "mixed outcomes: 3 pass / 3 fail in 6 runs; first failure at run #2; …",
    "createdAt": "…"
  },
  "runs": [ { "runIndex": 1, "outcome": "pass", "durationMs": 0.01 }, … ]
}
```

### GET /reports/:testName
Latest stored report plus every run record (replayable via `runIndex`).
404 NOT_FOUND if the test was never detected.

### GET /reports/:testName/trend
Cross-round history from SQLite: all rounds ordered by time, plus
`rounds` / `flakyRounds` counters. 404 NOT_FOUND if unknown.

### GET /health
`{"status":"ok"}`.

## Classification & confidence model

- **stable_pass**: all N runs pass. **stable_fail**: all N runs fail.
  Confidence = `1 - 2^-N` (more runs => more confidence).
- **flaky**: at least one pass and one fail.
  Confidence = `(2 * min(passes, failures) / N) * (1 - 2^-N)`.
  The balance term means 1 failure in 3 runs (0.5833) scores higher than
  1 failure in 10 runs (0.1998): an isolated rare failure is weaker evidence
  of flakiness than a frequently observed one.
- **Suggested retries** (flaky only): smallest k with
  `1 - failRate^(k+1) >= targetReliability`, capped at `maxRetries`.
  Stable tests get 0 (retrying a consistently failing test never helps).
- Flaky reports always include the pass/fail distribution and
  `firstFailureRun` (1-based index of the first failing run).

## Error semantics

Errors are never collapsed into success. Every error response is
`{"error":{"code","message","details?"}}` with a distinguishing HTTP status:

| Code               | HTTP | Raised when                                              |
|--------------------|------|----------------------------------------------------------|
| INPUT_ERROR        | 400  | malformed JSON, missing/invalid fields, runs < 1, unknown pattern |
| STATE_CONFLICT     | 409  | a detection round for the same test is already running   |
| RESOURCE_EXHAUSTED | 503  | requested runs exceed FLAKY_MAX_RUNS; body > 1 MiB       |
| COMPUTATION_FAILED | 500  | executor violated its contract; SQLite write/read failed |
| NOT_FOUND          | 404  | no route, or no history for the requested test           |
| INTERNAL_ERROR     | 500  | anything unexpected (bug)                                |

Executor throws are **test failures** (recorded as a `fail` run with the
error message in `detail`), not service errors.

## Logs & replayability

Every run is logged with its 1-based run number, outcome, duration and
failure detail; classification logs include the reasoning string (also stored
in the report). Example:

```
[kernel] test=login-test run=2/6 outcome=fail durationMs=0.42
[api] classified test=login-test as flaky confidence=0.9844 reason="mixed outcomes: …"
```

## Layout

```
src/config.ts            configuration layer (env-driven)
src/contract/            shared types + error contract (types.ts, errors.ts)
src/kernel/              execution kernel: runner.ts, classifier.ts, executors.ts
src/state/store.ts       SQLite adapter (history, trend queries)
src/api/                 diagnostic API: http-adapter.ts, routes.ts, server.ts
src/index.ts             service entry point
scripts/demo.ts          local demo (3 patterns + trend)
scripts/accept.ts        acceptance drill (npm run accept)
tests/                   node:test suites (classifier, runner, store, api)
```

## Stack notes

TypeScript + Node.js + SQLite (`node:sqlite`) as requested. The HTTP layer
is isolated behind the `NodeHttpAdapter` interface in
`src/api/http-adapter.ts`, which mirrors Fastify's route/handler shape
(`register(method, path, handler)`, handlers return `{status, body}`).
Fastify itself is declared as the intended production adapter but is not
vendored here because this workspace has no network access to install it;
swapping in Fastify means reimplementing the adapter's `register/listen/close`
against `fastify()` without touching routes, kernel, or state code.

## Reproducing the verification

```bash
npm test        # classifier reference values are hand-computed in the tests,
                # not generated by the implementation under test
npm run accept  # fixed-order drill: health, stable_pass, stable_fail, flaky
                # (distribution + firstFailureRun + confidence + retries),
                # cross-round trend, INPUT_ERROR, RESOURCE_EXHAUSTED,
                # COMPUTATION_FAILED, STATE_CONFLICT, NOT_FOUND
```
Both commands print per-step results and exit non-zero on any failure.
