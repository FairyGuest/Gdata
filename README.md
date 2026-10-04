# dynamic-nft-metadata

Dynamic NFT metadata service: token traits evolve with XP feeding and level
transitions. Metadata is rendered server-side as a pure function of (current
level, current XP, collection template). Concurrent feeds are serialized by
an internal transaction commit sequence - no lost updates.

## Stack & dependencies

- TypeScript, Node.js (>= 22.5, uses built-in `node:sqlite`), Fastify
- Runtime deps: `fastify`
- Dev deps: `typescript`, `tsx`, `@types/node`
- SQLite: Node built-in `node:sqlite` (no native build, no external DB)

## Layout

- `src/contract/` - request parsing & validation (feed/reset/metadata), XP
  value and admin permission checks; shared error contract (`ApiError`)
- `src/kernel/` - evolution kernel: threshold ladder arithmetic, level
  transitions, deterministic metadata renderer (pure functions, no I/O)
- `src/state/` - SQLite schema/migrations, seeded fixtures (collections,
  threshold ladder, tokens, admins), transactional feed/reset repository
- `src/diag/` - read-only level/transition history and ledger queries
- `src/config.ts` - configuration layer (db path, fixture seed, feed cap)
- `test/` - independent unit tests (`kernel.test.ts`, `api.test.ts`) and the
  one-shot acceptance script (`accept.ts`)

## Fixtures

Generated deterministically from a fixed seed (`fixtureSeed` in
`src/config.ts`) on first open: collection `dragons` with threshold ladder
`[7, 10, 15]` (max level 4) and tier templates bronze/silver/gold/diamond,
tokens 1-4 at level 1 / XP 0, and admin `admin-1`.

## API

- `POST /feed` `{ "tokenId": 1, "amount": 5 }` -> 200 receipt
  `{ tokenId, level, xp, consumed, transitions, commitSeq }`
- `POST /reset` `{ "tokenId": 1 }` with header `x-admin-id: admin-1` -> 200
- `GET /tokens/:id/metadata` -> complete server-rendered metadata JSON
- `GET /diag/tokens/:id/history` -> transitions ordered by commit sequence
- `GET /diag/tokens/:id/ledger` -> `{ total_fed, total_consumed, xp, level }`

## Error semantics

All errors return `{ "error": { "category", "reason", "status" } }`:

| status | category            | reasons                                                        |
|--------|---------------------|----------------------------------------------------------------|
| 422    | input_error         | `invalid_body`, `invalid_token_id`, `invalid_xp_amount`, `missing_admin_id`, `not_collection_admin`, `token_not_found` |
| 409    | state_conflict      | `max_level_reached`                                            |
| 503    | resource_exhausted  | `feed_amount_exceeds_capacity`, `database_busy`                |
| 500    | compute_failure     | `template_missing`, `template_corrupt`, `internal_failure`     |

## Semantics

- Feed accumulates XP; when XP >= threshold for the current level, the
  threshold is deducted and the level increases; the remainder carries over.
  XP accounting and level transitions commit in the same SQLite transaction.
- At max level, further feeds are rejected with 409 `max_level_reached`.
- Concurrent feeds on one token serialize on the single writer transaction;
  every feed takes effect (no last-write-wins). Ledger conservation:
  `total_fed = total_consumed + xp`.
- `metadata = f(level, xp, template)`; no clock, randomness or request ids.
  Level-dependent fields: `name`, `tier`, `image` (plus `level`/`xp`).
- Only a collection admin (fixture table `admins`) may reset a token to
  level 1 / XP 0; the next render reflects it immediately.

## Reproduce / verify

```sh
npm install
npm test        # 11 independent unit/integration tests
npm run accept  # one-shot acceptance: 6 scenarios, 20 steps, exit 0 on pass
npm run typecheck
npm start       # serve on http://127.0.0.1:3000 (DB_PATH, PORT env vars)
```

`npm run accept` prints a run id, every request/response and the verdict per
step; any failure exits non-zero and names the failed scenario.
