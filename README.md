# SBOM Vulnerability Scanner

A software bill-of-materials (SBOM) vulnerability scanning service.
Input: a set of packages and their dependency relations. The service resolves
the full transitive dependency graph, matches every package in the graph
(direct **and** transitive) against a vulnerability database by package name
and semantic-version range, and emits a severity-sorted report with the
dependency path from the root package to each vulnerable package.

## Tech stack

- **TypeScript** — run directly by Node.js type stripping (no build step)
- **Node.js >= 22.6** (developed and verified on v24.14.1)
- **Fastify-compatible HTTP layer** — `vendor/fastify` is a local, vendored
  Fastify-compatible module (offline environment; declared in
  `package.json` as "fastify": "file:vendor/fastify" and mirrored into
  `node_modules/fastify`). It implements the used subset: routing with
  params, JSON bodies, listen, inject, close.
- **SQLite** via the built-in `node:sqlite` module (no native builds)

No network access, production accounts, or real business data are required.
All data comes from local synthetic fixtures in `fixtures/`.

## Layout

| Path | Role |
| --- | --- |
| `src/contract/schema.ts` | Contract parsing: request validation + normalization |
| `src/contract/errors.ts` | Shared error taxonomy (ScanError, categories) |
| `src/core/semver.ts` | Semantic version compare + range matching (numeric, never lexicographic) |
| `src/core/graph.ts` | Transitive dependency graph resolution, cycle recording, resource guards |
| `src/core/matcher.ts` | Vulnerability matching + severity sorting |
| `src/core/engine.ts` | Execution kernel: orchestration, run ids, idempotency, run logs |
| `src/state/store.ts` | State adapter: SQLite (vulns, runs, run_logs) |
| `src/api/server.ts` | API/diagnostics layer: Fastify routes, error-to-status mapping |
| `src/config.ts` | Configuration layer (env-overridable) |
| `src/index.ts` | Service entry point |
| `fixtures/` | Synthetic vuln DB + SBOM fixtures |
| `test/` | Independent unit/integration tests (node:test) |
| `scripts/demo.ts` | Local demo |
| `scripts/accept.ts` | One-shot acceptance drill (npm run accept) |

## Quick start (from a clean checkout)

```sh
# 1. Install the local vendored dependency (offline-friendly).
npm install            # links vendor/fastify into node_modules
#    If npm is fully offline, equivalently:
#    mkdir node_modules/fastify && cp vendor/fastify/* node_modules/fastify/

# 2. Run the unit tests (25 tests).
npm test

# 3. Run the full acceptance drill (unit tests + 10 E2E scenarios).
npm run accept         # exit 0 = all green; non-zero = failed scenario printed

# 4. Run the demo.
npm run demo

# 5. Start the service.
npm start              # http://127.0.0.1:3000
```

## Configuration

All settings come from `src/config.ts`, overridable via environment:

| Env var | Default | Meaning |
| --- | --- | --- |
| SBOM_PORT / SBOM_HOST | 3000 / 127.0.0.1 | listen address |
| SBOM_DB_PATH | data/sbom.db | SQLite state database (runs, logs) |
| SBOM_VULN_DB | fixtures/vuln-db.json | vulnerability database (JSON) |
| SBOM_MAX_PACKAGES | 10000 | resource guard: max graph nodes |
| SBOM_MAX_DEPTH | 64 | resource guard: max dependency depth |

## API

### POST /scan

Request body:

```json
{
  "idempotencyKey": "optional-string",
  "root": "app@1.0.0",
  "packages": [
    { "name": "app", "version": "1.0.0", "dependencies": { "lib-a": "1.0.0" } },
    { "name": "lib-a", "version": "1.0.0", "dependencies": {} }
  ]
}
```

Response 200 (excerpt):

```json
{
  "runId": "run-<uuid>",
  "status": "completed",
  "stats": { "packagesScanned": 10, "cyclesDetected": 1, "maxDepth": 5 },
  "cycles": [{ "from": "lib-cycle2@1.0.0", "to": "lib-cycle@1.0.0" }],
  "findings": [
    {
      "vulnId": "VULN-001",
      "package": "lib-deep",
      "version": "1.4.0",
      "severity": "critical",
      "summary": "Remote code execution in lib-deep before 2.0.0",
      "dependencyPath": ["app@1.0.0", "lib-a@1.0.0", "...", "lib-deep@1.4.0"]
    }
  ]
}
```

Other endpoints:

- `GET /health` — liveness + loaded vulnerability count
- `GET /scan/:runId` — stored report (completed or failed)
- `GET /diagnostics/runs/:runId/logs` — ordered run events (run id,
  intermediate states, match decisions and rationale) for replay

### Version ranges

*, exact 1.2.3, comparator sets (>=1.0.0 <2.0.0, space-separated AND),
caret ^1.2.3, tilde ~1.2.3. All comparisons are numeric per semver
(1.10.0 > 1.9.0), never string ordering.

### Cycles

A dependency edge that would revisit a package already on the current path is
recorded in `cycles` and **not** expanded; the scan terminates normally.

### Idempotency

idempotencyKey + request fingerprint (SHA-256 of the body) are stored per
run. Replaying the same key with an identical body returns the original run;
reusing the key with a different body fails with STATE_CONFLICT.

## Error semantics

Errors are never reported as success. Error responses have the shape
`{ "error": { "category", "message", "detail" } }`; `detail.runId`
identifies the persisted failed run for diagnostics.

| Category | HTTP | Meaning | Example |
| --- | --- | --- | --- |
| INPUT_ERROR | 400 | contract/validation failure | bad semver, root not in packages, missing dependency |
| STATE_CONFLICT | 409 | idempotency key reused with a different payload | same key, changed packages |
| NOT_FOUND | 404 | unknown run id | GET /scan/run-nope |
| RESOURCE_EXHAUSTED | 413 | graph exceeds maxDepth/maxPackages | dependency chain too deep |
| COMPUTATION_FAILURE | 500 | unexpected internal failure (incl. unreadable vuln DB) | any uncategorized exception |

## Reproducing the verification scenarios

`npm run accept` executes, in fixed order, printing request/response/verdict
for each step (exit 0 iff all pass, non-zero naming the failed scenario):

1. Unit test suite (25 tests, concrete assertions incl. failure categories)
2. Health check
3. Deep transitive scan — vuln at depth 5 found with full dependency path
4. Version boundary exactly included (1.2.0 vs <=1.2.0)
5. Version boundary exactly excluded (1.2.1 vs <=1.2.0)
6. Cyclic dependency recorded, not expanded, scan terminates
7. Severity ordering critical > high > medium
8. Input error -> 400 INPUT_ERROR
9. Idempotent replay + 409 STATE_CONFLICT
10. Resource exhaustion -> 413 RESOURCE_EXHAUSTED
11. Diagnostics log replay

The expected answers in tests and in the acceptance script are hand-written
literals (paths, orderings, counts), not derived from the implementation
under test.

## Last recorded verification

- `npm test` — 25/25 pass (exit 0)
- `npm run accept` — 11/11 scenarios PASS (exit 0)
- `npm run demo` — prints severity-sorted report with dependency paths and a
  diagnostics excerpt
