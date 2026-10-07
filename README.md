# namespace-quota-service

Simulated cluster namespace & quota management service. Manages node
registration (cpu + memory capacity), namespaces (resource quota caps) and
workload placement requests, keeping quota and capacity accounting in sync.

Stack: TypeScript, Node.js (>= 22.5, developed on v24), Fastify 5, SQLite via
the built-in `node:sqlite` module (no native dependencies). All data is local
and synthetic; no external accounts or real business data required.

## Layout

| Path | Role |
| --- | --- |
| `src/config.ts` | Configuration layer (env-driven: `HOST`, `PORT`, `DB_PATH`) |
| `src/domain/types.ts` | Shared data & error contracts (`ServiceError`, `ErrorKind`) |
| `src/domain/validate.ts` | Contract parsing: untrusted input -> typed commands |
| `src/core/engine.ts` | Execution kernel: first-fit placement, FIFO queue, eviction, audit |
| `src/store/history.ts` | State adapter: SQLite placement history, queryable by namespace/node |
| `src/http/server.ts` | Fastify routes + diagnostics, maps error kinds to HTTP statuses |
| `src/index.ts` | Service entrypoint |
| `test/` | Independent engine + HTTP contract tests (node:test) |
| `scripts/demo.ts` | Local demo walkthrough |
| `scripts/accept.ts` | One-shot acceptance run (`npm run accept`) |

## Dependencies (pinned)

- fastify 5.12.5 (runtime)
- typescript 5.9.3, @types/node 24.19.1 (dev)
- SQLite: `node:sqlite` built into Node (emits an ExperimentalWarning, harmless)

## Quick start

```bash
npm install        # if your registry is offline: npm install --ignore-scripts
npm test           # build + run unit/contract tests, reports pass/fail counts
npm run accept     # build + full acceptance drill, exit 0 on success
npm start          # serve on 127.0.0.1:3000 (HOST/PORT/DB_PATH overridable)
npm run demo       # ephemeral-port demo of the main flows
```

`npm run accept` boots the service on an ephemeral port, then in a fixed order
exercises: first-fit determinism, quota-full rejection with exact shortfall,
release-triggered FIFO queue drain, namespace cascade eviction, conservation
audit (independent recomputation), error semantics, and SQLite history queries.
Each step prints the request, response and a PASS/FAIL verdict; the process
exits 0 only when every check passes, otherwise non-zero naming the failed
scenario(s).

## API

- `POST /nodes` `{id, capacity:{cpu, memoryMb}}`
- `POST /namespaces` `{name, quota:{cpu, memoryMb}}` -> 201
- `DELETE /namespaces/:name` -> cascade eviction, returns per-workload eviction records
- `POST /workloads` `{id, namespace, request:{cpu, memoryMb}}` -> 201 placed / 202 queued
- `DELETE /workloads/:id` -> releases node capacity + namespace quota, drains queue
- `GET /diag/state` | `GET /diag/audit` | `GET /diag/history?namespace=X&nodeId=Y`
- `GET /health`

### Placement semantics

- First-fit: nodes are scanned in registration order; the first node whose
  remaining capacity covers both cpu and memory wins. Same input sequence ->
  same decisions.
- Quota is checked before capacity. A request exceeding the namespace's
  remaining quota is rejected (not queued) with the exact per-dimension
  shortfall.
- If quota allows but no node fits, the request enters a FIFO wait queue and is
  retried, in order, after every capacity/quota release.
- Deleting a workload releases both the node capacity and the namespace quota
  in the same operation; deleting a namespace cascades: all its workloads are
  evicted (each eviction individually traceable) and both ledgers are refunded.
- Conservation invariant: sum of running workload requests == sum of node
  `used` == sum of namespace `used`, per dimension (`GET /diag/audit`).

## Error semantics

Errors are never collapsed into success. Body: `{error:{kind,message,details}}`.

| kind | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION` | 400 | Malformed input / contract parse failure (bad types, non-positive resources) |
| `NOT_FOUND` | 404 | Referenced namespace/workload does not exist |
| `CONFLICT` | 409 | Duplicate namespace name, node id, or workload id |
| `QUOTA_EXCEEDED` | 422 | Namespace quota insufficient; `details.shortfall` gives per-dimension gap |
| `INTERNAL` | 500 | Unexpected failure |

## Observability

Every engine mutation emits an event carrying `runId`, a monotonic `seq`, the
action and its rationale (e.g. `workload.placed`, `workload.queued`,
`queue.drained`, `capacity.released`, `workload.evicted`,
`workload.rejected` with shortfall). Events are persisted to SQLite
(`DB_PATH`, default `:memory:`) and queryable via `/diag/history` by
namespace and/or node, so any run can be replayed and audited.

## Reproduce verification

```bash
npm install
npm test        # 8 tests: quota+queue drain, first-fit determinism, cascade
                # eviction, conservation accounting, error contracts, HTTP API
npm run accept  # 28 ordered checks across 6 scenarios, prints each verdict
```

Latest local run: tests 8/8 pass; acceptance 28/28 checks passed, exit 0.
