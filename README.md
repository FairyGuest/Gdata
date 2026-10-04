# NFT Collection Bids

A local, deterministic service for whole-collection bids on NFTs. A bid covers
an entire collection and freezes the bidder's balance for the full price; any
seller explicitly chooses **which** of their own tokens in that collection to
accept against the bid. Settlement transfers ownership, deducts the buyer's
frozen balance, splits a proportional royalty and credits the seller - all in a
single SQLite transaction.

Stack: TypeScript, Node.js (built-in `node:sqlite`), Fastify. No external
accounts, network calls or real business data; the initial ledger is generated
from a fixed seed.

## Quick start

```sh
npm install
npm test        # unit/integration tests (node:test + Fastify in-process)
npm run accept  # one-shot acceptance drill (all scenarios, verbose log)
npm start       # HTTP server on 127.0.0.1:PORT (default ephemeral port)
```

Requirements: Node.js >= 22 with built-in SQLite (tested on v24).

`npm run accept` runs every required scenario in a fixed order against a fresh
in-memory database, printing each request, response and PASS/FAIL verdict.
Exit code is 0 only if every scenario passes; otherwise it exits non-zero and
lists the failed scenarios.

## Configuration

| Env var        | Default    | Meaning                                    |
| -------------- | ---------- | ------------------------------------------ |
| `BIDS_DB_PATH` | `:memory:` | SQLite file path                           |
| `BIDS_SEED`    | `20261001` | Fixture seed                               |
| `BIDS_RUN_ID`  | `run-*`    | Run id stamped on every diagnostic record  |
| `PORT`         | `0`        | HTTP port                                  |

## Seeded fixtures (seed 20261001)

- Collections: `col-alpha` (250 bps, recipient `royalty-alpha`),
  `col-beta` (500 bps, recipient `royalty-beta`).
- Tokens: `alpha-1..6` and `beta-1..4`; odd ids owned by `seller-1`,
  even ids by `seller-2`.
- Accounts: `buyer-1` (~50k), `buyer-2` (~2k), both sellers, and royalty
  recipients starting at 0.

## HTTP API

- `POST /bids` - body `{bidderId, collectionId, price}`; creates an open bid
  and freezes `price` from the bidder. The collection's royalty config is
  snapshotted onto the bid (`royaltyBps`, `royaltyRecipient`).
- `POST /bids/:bidId/cancel` - body `{actorId}`; only the creator; releases
  the freeze.
- `POST /bids/:bidId/accept` - body `{sellerId, tokenId}`; seller explicitly
  selects one token they own in the bid's collection. Full fill only; there is
  no partial fill, auto-pricing or auto token selection.
- `GET /bids/:bidId`, `GET /accounts/:userId`,
  `GET /fixtures/summary`, `GET /health`.
- `GET /diag/events?bidId=...` - transition log with run id, commit sequence,
  split breakdown and rejection reasons.
- `POST /admin/collections/:collectionId/royalty` - `{bps, recipient}`;
  affects future bids only (existing bids keep their snapshots).

## Settlement rules

- `royalty = floor(price * bps / 10000)`; `sellerProceeds = price - royalty`.
- Buyer always pays exactly `price` (frozen at bid creation, deducted at fill).
- Fill is atomic: conditional bid-state flip (`WHERE status='open'`), frozen
  deduction, seller + royalty credits and token ownership change commit
  together. Conservation assertions - `SUM(available + frozen)` invariant and
  `royalty + sellerProceeds == price` - roll the transaction back on failure.
  The bid state is never flipped ahead of the ledger updates.
- Concurrency is arbitrated by a monotonic SQLite **commit sequence**
  (`meta.commit_seq`, incremented inside `BEGIN IMMEDIATE`), never by request
  arrival timestamps. A loser that validated against an open bid gets
  `409 race_lost` carrying the winning commit sequence.

## Error taxonomy

Every error response is `{error, reason, message, details}`.

### 422 input errors (`error: "input"`)

| reason                    | Cause                                     |
| ------------------------- | ----------------------------------------- |
| `invalid_price`         | price missing, non-integer or <= 0        |
| `invalid_field`         | other malformed/missing string field      |
| `invalid_body`          | body is not a JSON object                 |
| `unknown_collection`    | collection id not found                   |
| `unknown_token`         | token id not found                        |
| `unknown_bid`           | bid id not found                          |
| `unknown_bidder`        | bidder account not found                  |
| `token_not_in_collection` | token's collection differs from the bid's |

### 409 state conflicts (`error: "conflict"`)

| reason                   | Cause                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `insufficient_balance` | available balance < bid price                               |
| `not_bid_creator`      | cancel invoked by someone other than the bidder             |
| `bid_already_filled`   | bid was already filled                                      |
| `bid_already_cancelled`| bid was already cancelled                                   |
| `seller_not_token_owner` | seller no longer holds the token at commit time           |
| `race_lost`            | validated against an open bid but a concurrent commit won   |

`race_lost` details include `currentStatus`, `winningCommitSeq` and
`observedStatusAtValidation` so the arbitration order is replayable.

### 503 resource exhaustion (`error: "resource"`)

| reason                | Cause                                  |
| --------------------- | -------------------------------------- |
| `storage_unavailable` | SQLite cannot be opened/migrated/used |
| `lock_wait_timeout`   | `SQLITE_BUSY` / lock wait expired    |

### 500 computation failures (`error: "internal"`)

| reason                   | Cause                                          |
| ------------------------ | ---------------------------------------------- |
| `conservation_violation` | balance invariant or split invariant broke    |
| `split_mismatch`        | royalty + seller proceeds != price             |
| `snapshot_missing`      | required row inconsistent inside the transaction |

## Diagnostics

Each matching operation persists rows in `diag_events`: run id, commit
sequence, bid id, transition (`null/open -> open/cancelled/filled`),
rejection reason, and a JSON detail containing the full split
(`price`, `royaltyBps`, `royalty`, `sellerProceeds`,
`royaltyRecipient`) or conflict context. Use `GET /diag/events` to inspect
and replay any scenario.

## Project layout

```text
src/
  config.ts          # config layer
  errors.ts          # shared error contract (422/409/503/500)
  fixtures.ts        # seeded synthetic ledger
  contract/          # request parsing + input/ownership validation
  kernel/engine.ts   # freeze semantics, tx boundary, conservation, race rules
  state/db.ts        # SQLite ledger: ownership, balances, bids, snapshots, diag
  diag/              # transition + split diagnostic log
  server.ts          # Fastify wiring
  main.ts            # entry point
tests/               # independent node:test suites with concrete assertions
scripts/accept.ts    # fixed-order acceptance drill
```

## Reproducing the required scenarios

`npm run accept` covers, in order: fixture health, freeze on create,
bid=1003/bps=250 split (25/978 checked against independent arithmetic),
insufficient balance, all 422 classes, creator/non-creator cancel and re-bid,
cancel-after-fill, snapshot isolation after a royalty config change,
coexisting bids, double-accept of one token, accept-vs-cancel commit-sequence
race with a deterministic interleaving gate, and end-to-end conservation plus
diagnostics.
