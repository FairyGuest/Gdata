# secrets-vault-B

A local, self-contained secrets vault service. Secrets are encrypted with AES-256-GCM,
stored versioned in SQLite, support rotation with a grace period, and every read/write
is recorded in a tamper-evident, append-only audit log committed in the same transaction
as the business operation. Time is controlled by an injected clock (VirtualClock in
tests/acceptance, SystemClock in production mode).

All data is synthetic local fixture data. No production accounts or real secrets.

## Stack & dependencies

- Node.js >= 22.5 (uses the built-in `node:sqlite` DatabaseSync; developed on Node 24)
- TypeScript, tsx (dev runner), Fastify 5, no native modules
- Install: `npm install`

## Layout

| Path | Role |
|---|---|
| `src/contract.ts` | Contract parsing: validates names/values/versions, maps bad input to typed errors |
| `src/kernel.ts` | Execution kernel: write/read/rotate orchestration, audit-in-transaction |
| `src/store.ts` | State adapter: SQLite schema, transactions, audit immutability triggers |
| `src/crypto.ts` | AES-256-GCM cipher (per-version AAD binds name+version) |
| `src/audit.ts` | Hash-chained audit log (SHA-256 chain from GENESIS) + verifier |
| `src/clock.ts` | Clock interface, SystemClock, VirtualClock |
| `src/errors.ts` | Error taxonomy: code -> category (INPUT/STATE/RESOURCE/COMPUTE) -> HTTP status |
| `src/server.ts` | Fastify HTTP surface + diagnostics routes |
| `src/config.ts`, `config/*.json` | Configuration layer |
| `fixtures/secrets.json` | Synthetic demo data |
| `test/vault.test.ts` | Unit/integration tests (node:test) |
| `scripts/accept.ts` | One-shot acceptance script (`npm run accept`) |
| `scripts/demo.ts` | Local demo entry (`npm run demo`) |

## Error semantics

Errors are never collapsed into success. Each error carries a machine-readable
`code`, a `category`, and an HTTP status:

| Code | Category | HTTP | Meaning |
|---|---|---|---|
| `VALIDATION` | INPUT | 400 | Malformed name/value/version |
| `NOT_FOUND` | STATE | 404 | Secret or version does not exist |
| `VERSION_EXPIRED` | STATE | 410 | Version's rotation grace period has elapsed (expired exactly at `expires_at`) |
| `CONFLICT` | STATE | 409 | Unsupported state transition (e.g. advancing a non-virtual clock) |
| `RESOURCE_EXHAUSTED` | RESOURCE | 413 | Value too large / version cap reached |
| `CRYPTO_FAILURE` | COMPUTE | 500 | AES-GCM authentication failed (tampered ciphertext/tag) |
| `AUDIT_INTEGRITY_FAILURE` | COMPUTE | 500 | Audit hash chain broken |
| `INTERNAL` | COMPUTE | 500 | Anything unexpected |

Response shape: `{ "error": { "code", "category", "message", "details?" } }`.

## HTTP API

- `PUT /secrets/:name` body `{"value": "..."}` -> creates a new version
- `GET /secrets/:name[?version=N]` -> latest or specific version (410 once expired)
- `GET /secrets/:name/versions` -> version metadata
- `POST /secrets/:name/rotate` -> retires all non-latest versions; they expire at `now + gracePeriodMs`
- `GET /audit[?name=X]`, `GET /audit/verify` -> audit entries / hash-chain verification
- `GET /health` -> diagnostics: clock, uptime, counts, audit integrity
- `POST /diag/clock/advance` body `{"ms": N}` -> only when a VirtualClock is injected
- Optional `X-Run-Id` header (or `runId` in body) is stamped onto audit entries.

## Reproduce from a clean checkout

    npm install
    npm test          # unit/integration tests, prints pass/fail counts
    npm run accept    # fixed-order end-to-end acceptance, exit 0 on success
    npm start         # serve with config/default.json (SystemClock, port 8787)
    npm run demo      # serve with config/demo.json (VirtualClock, port 8788)

Config is selected via `VAULT_CONFIG=<path>` or first CLI arg; defaults are in
`src/config.ts`. Example request:

    curl -X PUT localhost:8787/secrets/db-password -H 'content-type: application/json' -d '{"value":"s3cret-v1"}'
    curl "localhost:8787/secrets/db-password?version=1"

## Acceptance scenarios (npm run accept, fixed order)

1. S1 diagnostics `/health`
2. S2 multi-version write + read (v1..v3, latest + specific versions)
3. S3 rotation grace boundary: readable during grace and at `graceUntil - 1ms`, `410 VERSION_EXPIRED` exactly at `graceUntil`
4. S4 audit integrity: hash chain verifies, every entry has runId + reason, failures audited
5. S5 encrypt/decrypt roundtrip + at-rest ciphertext check
6. S6 error categories: INPUT/STATE/RESOURCE distinguished by code, category, and status

Each step prints the request, response, and a PASS/FAIL judgement. Exit code is 0
only if every judgement passes; otherwise non-zero with the failing scenario named.
