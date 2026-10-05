# chaos-injector-a

A chaos fault-injection service that sits in front of a healthy HTTP service as a proxy and
injects configurable faults into live traffic. Faults never touch the target service itself —
stop the injection and the target is instantly back to normal.

## Fault types

| Type         | Effect                                                        | Params                          |
|--------------|---------------------------------------------------------------|---------------------------------|
| `latency`    | sleeps before forwarding                                      | `delayMs` (default 200)         |
| `abort`      | destroys the client connection (no response)                  | —                               |
| `errorStatus`| short-circuits with an error status, target never sees it     | `statusCode` 400–599 (def. 500) |
| `truncate`   | cuts the response body to a fraction of its length            | `keepRatio` in (0,1) (def. 0.3) |

Every fault has its own `probability` (0–1, per request, independent rolls) and optional
`durationMs` (auto-stop timer; omit for manual-stop-only). Multiple faults can be active at
once and are started/stopped independently.

## Requirements

- Node.js >= 22.5 (developed and verified on v24.14.1). No runtime npm dependencies.
- TypeScript runs natively via Node's type stripping (`tsconfig.json` + `npm run typecheck`
  are provided for editors / optional `tsc` use; `typescript` is a dev-only dependency).

> Note on stack: the brief asked for Fastify + SQLite. The SQLite side uses the built-in
> `node:sqlite` module. The HTTP layer is an isolated adapter (`src/http.ts`) over `node:http`
> because the npm registry was unreachable in the build environment; swapping in Fastify only
> means re-implementing that one adapter — kernel, state, store and contracts are untouched.

## Layout

- `src/contracts.ts` — shared data & error contracts (`ChaosError` with stable codes)
- `src/config.ts` — config layer: defaults <- `config/chaos.config.json` <- env, validated
- `src/kernel.ts` — execution kernel: pure per-request fault decisions (seedable rng)
- `src/state.ts` — state adapter: fault lifecycle, auto-stop timers, history bridge
- `src/store.ts` — SQLite persistence (`sessions`, `events` tables)
- `src/proxy.ts` — fault-applying reverse proxy
- `src/diagnostics.ts` — admin/diagnostic API (`/chaos/*`, `/health`)
- `src/http.ts` — thin HTTP adapter (router, JSON, error mapping)
- `src/server.ts` — service entry; `src/target.ts` — demo target service
- `test/` — unit + integration tests; `scripts/accept.ts` — acceptance drill; `scripts/demo.ts`

## Run

```sh
npm run start:target   # demo target on :8500 (separate terminal)
npm start              # chaos proxy on :8400, config from config/chaos.config.json
npm run demo           # self-contained demo (boots both, injects, prints history)
```

Config keys: `proxyPort`, `targetUrl`, `dbPath`, `initialFaults`.
Env overrides: `CHAOS_PROXY_PORT`, `CHAOS_TARGET_URL`, `CHAOS_DB_PATH`, `CHAOS_CONFIG`.

## API examples

```sh
# start latency injection: 50% of requests delayed 300ms, auto-stop after 10s
curl -X POST localhost:8400/chaos/faults/latency/start   -H 'content-type: application/json'   -d '{"probability":0.5,"durationMs":10000,"params":{"delayMs":300}}'

curl -X POST localhost:8400/chaos/faults/latency/stop
curl -X POST localhost:8400/chaos/stop-all
curl localhost:8400/chaos/status
curl localhost:8400/chaos/sessions
curl localhost:8400/chaos/sessions/<sessionId>   # includes affectedRequests count + events
```

Each injection event is persisted with timestamp, fault type, actual duration and the
affected request id; `GET /chaos/sessions/:id` reports how many requests a given injection
session affected.

## Error semantics

Errors are never reported as success. Body shape: `{"error":{"code","message","requestId"}}`.

| HTTP | Code                   | Category            | Meaning                                  |
|------|------------------------|---------------------|------------------------------------------|
| 400  | `INVALID_CONFIG`       | input error         | bad probability/params/body/fault type   |
| 409  | `FAULT_ALREADY_ACTIVE` | state conflict      | starting a fault that is already running |
| 409  | `FAULT_NOT_ACTIVE`     | state conflict      | stopping a fault that is not running     |
| 404  | `NOT_FOUND`            | input error         | unknown session id / route               |
| 502  | `UPSTREAM_ERROR`       | resource failure    | target service unreachable               |
| 503  | `STORE_ERROR`          | resource failure    | sqlite open/write/read failure           |
| 500  | `INTERNAL`             | computation failure | anything unexpected                      |

Logs are structured JSON lines containing `runId`, event name, key state and the reason for
each decision (`fault.start`, `fault.autoStop`, `proxy.inject`, `http.error`, ...), so a run
can be replayed from its log.

## Tests & acceptance

```sh
npm test         # 20 tests: kernel statistics, config contracts, state lifecycle, end-to-end
npm run accept   # fixed-order drill of every scenario, prints request/response/verdict
```

`npm run accept` boots a fresh target + proxy on ephemeral ports and exercises, in order:
baseline pass-through, latency timing (measured >= injected), probabilistic distribution
(p=0.5 over 200 requests, sqlite count must equal observed count), errorStatus, truncate,
abort, simultaneous multi-fault with independent stop, auto-stop after `durationMs`, and
error-semantics distinguishability. Exit code 0 = all passed; non-zero prints the failed
scenario. Verified on Node v24.14.1: 20/20 tests pass, acceptance drill exits 0.
