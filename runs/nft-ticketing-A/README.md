# NFT 电子门票服务（本地最小可验收实现）

按场次发售座位唯一的电子门票，支持购票、转让、退票与检票；已检票为终态；
每人每场限购额度与退票释放联动。所有数据来自固定种子生成的本地合成夹具，
无需任何生产账号或外部服务。

技术栈：TypeScript + Node.js + Fastify + SQLite（使用 Node v24 内置的
`node:sqlite`，无需原生编译）。

## 快速开始

前置：Node.js >= 24（内置 `node:sqlite`，运行时加 `--experimental-sqlite`）。

```bash
npm install
npm test        # 独立单元/HTTP 测试（8 个）
npm run accept  # 一键验收：按固定顺序演练全部场景，逐步打印请求/响应/判定
```

- `npm run accept` 全部通过时进程退出码为 `0`；任一断言失败退出非 `0` 并指出失败场景。
- 启动 HTTP 服务（可选）：`node --experimental-sqlite --import tsx src/app.ts`，默认端口 3000。

## 工程结构

| 路径 | 职责 |
| --- | --- |
| `src/contract/` | 购票/转让/退票/检票参数解析、场次座位与数量校验、统一错误分类（`errors.ts`、`parser.ts`、`types.ts`） |
| `src/kernel/` | 售票决策内核：座位唯一性、限购、余额扣款、票状态机、事务边界、提交序号裁决（`kernel.ts`） |
| `src/state/` | SQLite 账本与迁移：场次/座位、票状态、余额、限购计数、归属日志、提交日志（`ledger.ts`、`migrate.ts`、`fixtures.ts`） |
| `src/diag/` | 只读诊断：票状态、归属历史、余额/持有数、每次运行的尝试记录（`queries.ts`） |
| `src/app.ts` | Fastify 路由与错误到 HTTP 状态码的映射 |
| `test/` | 独立测试（内核 + HTTP），断言具体结果与失败类别 |
| `scripts/accept.ts` | 一键验收脚本 |

## 固定夹具

场次 `S1`（限购每人 2 张），座位 `A-1/A-2/A-3`，单价均为 100；
用户 `alice`、`bob` 余额 1000，`carol` 余额 50。见 `src/state/fixtures.ts`。

同一座位在退票后可再次发售，票使用代际 ID：`<场次>:<座位>#g<代际>`
（例如 `S1:A-1#g1`、退票重售后为 `S1:A-1#g2`）。

## 并发裁决语义

每次状态变更在单个 SQLite `BEGIN IMMEDIATE` 事务内完成。并发抢购同一座位时：

- 裁决依据是事务**提交序号**（全局 `commit_log` 自增），不是请求到达时间戳；
- 座位唯一性在事务内**显式校验**（`liveSeatExists`），失败返回可区分的 `seat_taken`，
  数据库上的唯一索引仅作为兜底，不作为判定路径；
- 扣款与出票在同一事务提交。

验收脚本中买家 B 被刻意“先提交”，用以证明到达顺序不影响裁决（胜者由提交序号决定）。

## 错误语义

| HTTP | errorClass | 含义 | 独立 reason |
| --- | --- | --- | --- |
| 422 | `input` | 输入错误 | `missing_field`、`invalid_type`、`unknown_session`、`unknown_seat`、`unknown_user`、`unknown_ticket`、`same_user_transfer` |
| 409 | `conflict` | 状态冲突 | `seat_taken`、`purchase_limit_reached`、`insufficient_funds`、`not_holder`、`already_checked_in`、`voided` |
| 503 | `exhausted` | 资源耗尽 | `ledger_busy`、`balance_pool_exhausted` |
| 500 | `compute` | 计算失败 | `invariant_violated`、`transaction_failed`、`unexpected_error` |

冲突类失败也会写入 `commit_log` 与 `run_attempts`，保证提交顺序是全序且可重放。

## 票状态机

`held -> checked_in`（检票，终态）；`held -> voided`（退票）。

- 转让仅当前持有者可操作；`checked_in`/`voided` 均拒绝转让。
- 已检票不可转让、不可退票、不可重复检票；已退票不可转让、不可再检、不可重复退票。
- 检票只锁定状态，`ownership_log` 完整保留历史归属（issue/transfer/checkin/refund），不被改写。
- 退票原子地：退款到余额、释放限购计数、释放座位（座位可再售）。

## HTTP 接口

所有写接口为 `POST`，请求体为 JSON，均需携带 `runId`（运行编号）与正整数 `seq`
（该运行内的请求序号，用于可重放诊断；裁决仍以提交序号为准）。

- `POST /tickets/purchase` — `{ runId, seq, sessionId, seatCode, userId }`
- `POST /tickets/transfer` — `{ runId, seq, ticketId, fromUserId, toUserId }`
- `POST /tickets/refund` — `{ runId, seq, ticketId, userId }`
- `POST /tickets/checkin` — `{ runId, seq, ticketId, userId }`
- `GET /diag/tickets/:ticketId` — 票状态 + 归属历史
- `GET /diag/sessions/:sessionId/seats/:seatCode` — 某座位当前有效票
- `GET /diag/users/:userId` — 余额与当前持有数
- `GET /diag/runs/:runId` — 该运行所有尝试（请求序号、是否成功、reason、提交序号）

成功返回 `200 { result: { ok:true, runId, seq, action, commitSeq, ticketId } }`；
冲突返回 `409 { result: { ok:false, reason, errorClass:"conflict", ... } }`；
输入错误返回 `422 { error: { errorClass, reason, message, detail? } }`。

## 可诊断性

`runId` + `seq` 标识每次尝试，`commitSeq` 记录全局提交顺序，`ownership_log` 与
`run_attempts` 保留关键中间状态与判定理由；验收脚本逐步打印请求、响应与 PASS/FAIL 判定。
