# Dynamic NFT Metadata Service

A minimal TypeScript / Node.js / Fastify / SQLite service where a token's
on-chain-style metadata **evolves with XP feeds and level transitions**.

- Metadata is a **pure function** of `(level, xp, collection template)` —
  same state always renders byte-identical JSON; no timestamps, randomness or
  request ids are ever mixed in.
- XP feeds accumulate; reaching a level threshold consumes that threshold,
  levels the token up and carries the remainder forward. Level-up and XP
  accounting commit in the **same SQLite transaction**.
- Concurrent feeds to the same token are **serialized by an internal
  per-token commit queue**, so every feed takes effect (no lost updates / no
  last-write-wins). Ledger invariant:
  `sum(feeds) == sum(consumed thresholds) + current XP`.
- Reset (back to level 1 / xp 0) is restricted to the collection's admins;
  feeding a max-level token returns `409 max_level_reached`.

All data is local synthetic fixture data (deterministic seed): no production
accounts or network services are used.

## Requirements

- Node.js >= 22 (uses the built-in `node:sqlite` module; developed on Node 24)
- npm

## Install & one-command acceptance

```bash
npm install
npm run accept     # full ordered scenario walkthrough, exit 0 only if all pass
npm test           # kernel/render unit checks against an independent oracle
npx tsc -p tsconfig.json --noEmit   # type check
```

`npm run accept` spins up an in-memory server via Fastify's inject transport
(no real port / network timing dependence) and runs a fixed sequence of
scenarios, printing every request, response and verdict. Each run prints a
**RUN_ID**; every feed/level/reset event row is tagged with that id so a run
can be replayed/correlated through the diagnostic endpoints.

Optional HTTP server:

```bash
npm start            # PORT=3000, NFT_DB_FILE defaults to :memory:
```

Configuration (env):

| Var | Default | Meaning |
| --- | --- | --- |
| `NFT_DB_FILE` | `:memory:` | SQLite file path |
| `NFT_SEED` | `20261001` | fixture seed label |
| `NFT_LOCK_WAIT_MS` | `1000` | max wait in the per-token feed queue |
| `NFT_RUN_ID` | random UUID | id stamped on events/responses |
| `PORT` | `3000` | HTTP listen port |

## API

- `POST /feed` — body `{ collectionId, tokenId, amount }` →
  `{ ok, runId, seq, level, xp, consumedXp, levelsGained }`.
- `POST /reset` — header `x-admin-id`, body `{ collectionId, tokenId }`.
- `GET /metadata/:collectionId/:tokenId` — complete server-rendered metadata.
- `GET /diag/token/:collectionId/:tokenId` — current level/xp/consumed/version.
- `GET /diag/history/:collectionId/:tokenId` — feed events, level events and
  the conserved ledger (`totalFed = totalConsumed + currentXp`).
- `GET /healthz`.

### Seeded fixtures

- collection `heroes` — thresholds `[10, 20, 40, 80]` (levels 1..5),
  tokens `TKN-001`, `TKN-002`, admin `admin-alice`.
- collection `sprites` — non-divisible ladder `[7, 11, 17]` (levels 1..4),
  token `SPK-007`, admin `admin-bob`.

Each level supplies its own `name`, `tier` and `image`; all other metadata
fields are level-independent.

## Error semantics

Every error response is `{ error, reason, detail, runId }`. Categories never
collapse into success and each `reason` is distinct:

| HTTP | category | Example reasons |
| --- | --- | --- |
| 422 | `input` | `invalid_body`, `missing_identifier`, `malformed_identifier`, `missing_admin_credentials`, `invalid_xp_amount`, `xp_amount_not_integer`, `xp_amount_not_positive`, `xp_amount_too_large`, `corrupt_collection_fixture` |
| 409 | `conflict` | `max_level_reached`, `token_not_found`, `collection_not_found`, `not_collection_admin`, `token_version_conflict` |
| 503 | `exhausted` | `feed_serialization_timeout` (queued behind another feed longer than the wait budget) |
| 500 | `compute` | `invalid_token_level`, `invalid_token_xp`, `invalid_consumed_xp`, `ladder_threshold_unavailable`, `xp_overflow`, `unexpected_internal_error` |

## Project layout

- `src/contract/` — request parsing, XP numeric validation, error taxonomy.
- `src/kernel/` — pure evolution core (threshold ladder, transition
  arithmetic) and pure metadata rendering.
- `src/state/` — SQLite schema/migrations, deterministic fixtures and the
  transactional repository (per-token feed queue + optimistic version guard).
- `src/diag/` — read-only status / feed / level / ledger queries.
- `src/server.ts`, `src/main.ts`, `src/config.ts` — HTTP wiring, bootstrap, config.
- `test/unit.ts` — kernel/render checks cross-validated by an **independent
  arithmetic oracle** in `test/oracle.ts` (not derived from the implementation).
- `test/accept.ts` — ordered end-to-end acceptance walkthrough.

## Reproducing the required scenarios

They are all part of `npm run accept`:

1. Concurrent double feed (`25` and `30` to `heroes/TKN-001`): both 200,
   distinct commit seqs, final level 3 / xp 25 / consumed 30, ledger
   `55 = 30 + 25`.
2. Non-divisible ladder (threshold 7): feed 5 then 4 to `sprites/SPK-007`
   → +1 level, xp 2, compared with the independent oracle.
3. Determinism: render the same state twice → byte-identical; level-up changes
   exactly `name`, `image` and the `attributes` array.

