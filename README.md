# env-secrets-binding

Environment secret binding & injection service. Manages secret declarations on a
three-level scope tree (org / project / environment) and, at environment creation
time, resolves the effective secret set and freezes it into an injection snapshot.
Binding & resolution semantics only — no encryption at rest.

## Stack & dependencies

- Node.js >= 22.6 (developed on v24.14.1; TypeScript runs natively via type stripping)
- SQLite via the built-in `node:sqlite` module (no native addon, no external DB)
- fastify ^5.2.0 (only runtime dependency)
- dev: typescript ^5.7.2, @types/node ^22.10.0 (type checking only)

Install: `npm install`

## Layout

- `src/domain/` — contract: types, error codes, pure resolution kernel (`resolver.ts`)
- `src/service/` — execution kernel: `BindingService` orchestration + run logger
- `src/state/` — state adapter: SQLite store (declarations, environments, snapshots)
- `src/http/` — diagnostics/API interface: Fastify routes + error mapping
- `src/config.ts` — config layer (env vars: `PORT`, `HOST`, `DB_PATH`, `FINGERPRINT_LENGTH`)
- `src/index.ts` — service entry point
- `test/binding.test.ts` — independent tests (node:test, in-memory SQLite)
- `scripts/demo.ts` — local demo against in-memory store
- `scripts/accept.ts` — one-shot acceptance run (`npm run accept`)

## Semantics

- **Nearest-scope override, per key**: for each required name, the declaration at
  the deepest scope in the chain `org -> project -> env` wins. Decided
  independently per key; each result carries `level` and `sourcePath`.
- **Snapshot isolation**: creating an environment freezes the resolution into an
  injection snapshot (declaration id + version + value + fingerprint). Later
  declaration updates do not affect existing environments.
- **Masked queries**: `GET /environments/:id/secrets` returns only
  `{ name, level, fingerprint }` where fingerprint = first N hex chars of
  sha256(value) (N = `FINGERPRINT_LENGTH`, default 12). Plaintext never leaves
  the query API.
- **Referential integrity**: deleting a declaration still referenced by snapshots
  of active environments returns `409 CONFLICT_REFERENCED` with the referrers.
  Deleting an environment cascades its snapshots.
- **Bindings query**: `GET /bindings?envId=...` or `?name=...` joins snapshots
  with environments for lookup by environment or by secret name.

## Error contract

All errors are JSON: `{ "error": { code, message, details, runId } }`.
`runId` also comes back as the `x-run-id` response header and appears in the
structured run logs (step, intermediate state, reason, outcome) for replay.

| code                 | HTTP | meaning                                             |
|----------------------|------|-----------------------------------------------------|
| VALIDATION_ERROR     | 400  | malformed input (bad scopeType, empty fields, ...)  |
| MISSING_SECRETS      | 422  | required names undeclared at any scope; `details.missing` lists them |
| NOT_FOUND            | 404  | environment or declaration does not exist           |
| CONFLICT_DUPLICATE   | 409  | environment id already exists                       |
| CONFLICT_REFERENCED  | 409  | declaration still referenced by active env snapshots; `details.referencedBy` |
| INTERNAL_ERROR       | 500  | unexpected failure                                  |

Failures are never collapsed into success: input errors, state conflicts and
internal failures are distinct codes with distinct HTTP statuses.

## API

- `PUT /scopes/:scopeType/:scopeId/secrets/:name` body `{ "value": "..." }` — declare/upsert (bumps version)
- `DELETE /scopes/:scopeType/:scopeId/secrets/:name` — delete declaration (409 if referenced)
- `POST /environments` body `{ id?, orgId, projectId, name, requiredSecrets: [...] }` — create env + freeze snapshot (201)
- `GET /environments/:envId/secrets` — masked secret list
- `DELETE /environments/:envId` — delete env, cascade snapshots
- `GET /bindings?envId=..&name=..` — binding rows (at least one filter required)
- `GET /health`

### Example

```sh
npm start   # listens on 127.0.0.1:3000, db at data/secrets.db

curl -X PUT localhost:3000/scopes/org/org-1/secrets/API_KEY -H 'content-type: application/json' -d '{"value":"org-key"}'
curl -X PUT localhost:3000/scopes/project/proj-1/secrets/API_KEY -H 'content-type: application/json' -d '{"value":"proj-key"}'
curl -X POST localhost:3000/environments -H 'content-type: application/json' \
  -d '{"orgId":"org-1","projectId":"proj-1","name":"staging","requiredSecrets":["API_KEY"]}'
curl localhost:3000/environments/<envId>/secrets
```

## Reproduce / verify

```sh
npm install
npm test        # 9 independent tests: override, isolation, masking, missing, 409, cascade, bindings, run log
npm run demo    # in-memory walkthrough of the full lifecycle
npm run accept  # boots real HTTP service on a temp SQLite db, runs all scenarios
                # in fixed order, prints request/response/verdict per step;
                # exit 0 on all-pass, non-zero otherwise
npm run build   # tsc type check
```

All data is synthetic and local; no external accounts or network services needed.
