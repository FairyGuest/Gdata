# NFT 集合出价服务（Collection-wide Bids）

出价面向整个 NFT collection 全局生效：买方对集合出价时冻结等额余额；卖方从自己持有的、属于该集合的 token 中显式选定一个成交。不支持部分成交、不做自动选价或自动选 token。结算时按出价创建时的集合版税快照做按比例拆分，所有权转移、冻结额扣减、版税拆分与卖方入账在同一个 SQLite 事务内提交。

技术栈：TypeScript（NodeNext 严格模式）、Node.js ≥ 22.5、Fastify 5、内置 `node:sqlite`（WAL），零外部服务、零生产数据。

## 快速开始

```bash
npm install
npm run accept     # 一键验收：固定顺序演练全部场景，全通过退出 0，任一失败退出 1
npm run test       # node:test 独立测试（26 个用例）
npm run typecheck  # tsc --noEmit 严格类型检查
npm start          # 启动 HTTP 服务（默认 127.0.0.1:8080，数据在 data/nft-bids.db）
```

`npm run accept` 逐步打印每个场景的 REQUEST、RESPONSE 和 `[PASS]/[FAIL]` 判定；诊断事件同时写入 `logs/accept.jsonl`。

## 并发裁决模型

- 所有写操作在 `BEGIN IMMEDIATE ... COMMIT` 中执行；SQLite 单写锁天然串行化写事务。
- 唯一的裁决依据是提交后自增的 `commit_log.seq`（内部事务提交序号），不使用请求到达时间、时间戳或网络顺序。
- 预检查只用于尽早给出 422/明确 409；真正的状态判定在持锁事务内重检。若预检查后状态已被别的提交改变（如 accept 进行中被取消、或取消进行中被成交），落败方得到 `409 commit_race_lost`，其 details 含 `winningCommitSeq` 与 `arbitration: sqlite_commit_log_seq`。
- 写锁等待超过 `LOCK_TIMEOUT_MS`（默认 5000ms，验收中用 200ms 主动触发）返回 `503 lock_timeout`。

## 版税与守恒语义

- `royalty = floor(bid × bps / 10000)`（整数向下取整），`sellerAmount = bid − royalty`，买方实付恒为 `bid`。
- 多方版税按权重用最大余数法（largest remainder）拆分，保证各笔版税之和精确等于 royalty 总额；`seller + Σroyalty = price`。
- 版税配置在**出价创建时**快照存入 bids 行（`royalty_bps_snapshot`、`recipients_snapshot_json`）；之后 `POST /v1/admin/collections/:id/royalty` 修改配置只影响新出价，不影响已存在出价。
- 每个事务内断言：所有余额变动满足 `Σ(Δavailable + Δfrozen) = 0`（可用+冻结两类余额变动之和为零），且拆分之和等于成交价；断言失败抛 `500 invariant_violation` 并回滚，不会先翻转状态再补账。

## 固定种子夹具（`src/state/fixtures.ts`）

seed 默认 `20261001`，可通过 `SEED` 环境变量覆盖。

| 用户 | 初始可用余额 | 角色 |
| --- | --- | --- |
| `u_alice` | 10000 | 主要买方 |
| `u_bob` | 10000 | 主要卖方 |
| `u_carol` | 8000 | 买方 / 30% 版税方 |
| `u_dave` | 5000 | 集合创建者 / 70%（或 100%）版税方 |
| `u_eve` | 300 | 低余额买方（冻结边界） |

集合：`col_punks`（250 bps，dave70/carol30）、`col_apes`（1000 bps，dave100）。

token：`t_punk_1`、`t_punk_3`、`t_ape_1`、`t_ape_2` 属于 u_bob，`t_punk_2` 属于 u_carol。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/bids` | 创建集合出价并冻结 `{bidderId, collectionId, amount}` |
| POST | `/v1/bids/:bidId/cancel` | 仅创建者取消，解冻 `{requesterId}` |
| POST | `/v1/bids/:bidId/accept` | 卖方选定自己的 token 成交 `{sellerId, tokenId}` |
| GET | `/v1/bids?collectionId=` | 出价簿 |
| GET | `/v1/bids/:bidId` | 出价、状态转移、版税支付明细 |
| GET | `/v1/collections` / `/v1/collections/:id` | 当前版税配置 |
| POST | `/v1/admin/collections/:id/royalty` | 修改当前版税配置（不影响存量出价快照） |
| GET | `/v1/tokens/:id` / `/v1/accounts` / `/v1/accounts/:id` | 所有权与余额视图 |
| GET | `/v1/ledger/totals` | 两类余额合计 |
| GET | `/diag/events?bidId=&limit=` | 运行编号、状态转移、拆分明细与判定理由 |
| GET | `/diag/commits?limit=` | 提交序号日志（裁决真源） |

错误响应统一形如：

```json
{ "error": { "category": "conflict", "reason": "commit_race_lost", "message": "...", "runId": "run-...", "details": { "winningCommitSeq": 15 } } }
```

## 错误分类

| HTTP | category | reason | 触发情形 |
| --- | --- | --- | --- |
| 422 | input | `malformed_body` | 请求体不是合法 JSON 对象 |
| 422 | input | `missing_field` | 必填字段缺失/为空（含 amount 为 null） |
| 422 | input | `price_not_positive_integer` | 价格非正整数（0、负数、小数、非数字串） |
| 422 | input | `unknown_collection` / `unknown_token` / `unknown_bid` / `unknown_user` | 引用不存在的资源 |
| 422 | input | `token_not_in_collection` | token 不属于出价所在集合 |
| 409 | conflict | `insufficient_balance` | 可用余额不足以冻结 |
| 409 | conflict | `bid_already_filled` / `bid_already_cancelled` | 对已终结出价操作 |
| 409 | conflict | `not_bid_owner` | 非创建者取消 |
| 409 | conflict | `seller_does_not_own_token` | 卖方在成交事务内已不持有该 token（含同一 token 被第二次 accept） |
| 409 | conflict | `commit_race_lost` | 预检查后出价被并发提交改变，按 commit seq 落败 |
| 503 | unavailable | `storage_unavailable` / `lock_timeout` | 存储不可打开/损坏、写锁等待超时 |
| 500 | compute | `invariant_violation` / `unexpected_error` | 守恒断言失败、拆分不平或未知异常，不返回成功 |

## 目录结构

```
src/
  config/      配置层（端口、DB 路径、seed、锁超时、诊断文件）
  contract/    契约解析、价格/资源存在性/归属校验、版税整数算术、错误契约
  kernel/      撮合内核：冻结语义、事务边界、守恒断言、提交序号裁决、只读查询
  state/       SQLite 引擎(WAL/连接池/写锁重试)、schema 迁移、固定种子夹具、账本仓储
  diag/        运行编号、状态转移与拆分明细日志、Fastify 路由
  app.ts       组装（依赖注入），main.ts 为入口
test/          node:test：算术/契约、内核竞态与守恒、HTTP 端到端
scripts/accept.ts  一键验收脚本（事务钩子确定性重放并发）
```

## 确定性并发重放

内核写事务暴露 `hooks.afterBegin`（拿到写锁后挂起），测试与验收脚本据此构造确定性交错：让 accept 先持锁挂起，再发起 cancel，随后释放 accept。提交顺序因此固定为 accept 先 commit、cancel 落败为 `commit_race_lost`，且可断言成交后冻结已扣减（取消路径则解冻并使 accept 409，由提交序号决定）。

## 环境变量

`PORT`（8080）、`HOST`（127.0.0.1）、`DB_PATH`（data/nft-bids.db，可用 `:memory:`）、`SEED`（20261001）、`LOCK_TIMEOUT_MS`（5000）、`SQLITE_BUSY_TIMEOUT_MS`（5000）、`DIAG_LOG_PATH`（logs/diag.jsonl，设为空串则只保留内存事件）。
