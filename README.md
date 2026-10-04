# NFT 固定价挂单市场（nft-marketplace）

基于 TypeScript + Node.js + Fastify + SQLite（`node:sqlite`）的固定价 NFT 挂单市场服务。支持挂单、取消、成交结算（含按比例版税拆分），并对 soulbound 资产在服务端拒绝一切交易。所有数据来自固定种子的本地合成夹具，无任何外部账号或网络依赖。

## 快速开始

```bash
npm install        # 安装依赖（fastify / typescript / @types/node）
npm test           # 运行全部测试（node:test，24 个用例）
npm run accept     # 一键验收：按固定顺序演练全部场景，全部通过退出 0，任一失败非 0
npm start          # 启动 HTTP 服务（默认 127.0.0.1:3000，内存数据库）
npm run typecheck  # 仅类型检查
```

环境变量（`src/config.ts`）：`MARKET_DB`（SQLite 路径，默认 `:memory:`）、`MARKET_SEED`（夹具种子，默认 `1337`）、`PORT`、`HOST`。

## 工程结构

| 目录 | 职责 |
| --- | --- |
| `src/contract/` | 请求参数解析与校验（价格为正整数、bps ∈ [0,10000]、collection/token/user 存在性）；错误分类法（`errors.ts`） |
| `src/kernel/` | 成交内核：事务边界、守恒断言、提交序号（commit_seq）并发裁决 |
| `src/state/` | SQLite 账本：所有权、余额、订单簿、collection 快照、schema 迁移 |
| `src/diag/` | 诊断日志：订单状态转移、成交拆分明细、判定理由（均带 runId/requestId） |
| `src/fixtures/` | 固定种子（mulberry32）生成初始账本：collections（版税/soulbound 配置）、代币所有权、用户余额 |
| `src/http/` | Fastify 路由与错误到 HTTP 状态的映射 |
| `test/` | 独立测试（状态机、版税、并发、soulbound、错误分类） |
| `scripts/accept.ts` | 一键验收脚本 |

## HTTP 接口

- `POST /orders` `{tokenId, sellerId, price}` → 201 挂单（快照 collection 版税配置）
- `POST /orders/:id/cancel` `{actorId}` → 200 取消（仅创建者）
- `POST /orders/:id/accept` `{buyerId}` → 200 成交（原子结算）
- `GET /orders/:id` / `GET /collections/:id`
- `GET /diag/health` 守恒探针（余额总和 vs 种子期望值、commitSeq、fills 数）
- `GET /diag/orders/:id/events` 订单状态转移日志
- `GET /diag/fills/:orderId` 成交拆分明细
- `GET /state/ledger` 全量账本快照（调试）

## 错误语义

所有错误响应为 `{error: {category, reason, message, details, runId, requestId}}`，`category × reason` 可程序化区分：

| HTTP | category | reason | 含义 |
| --- | --- | --- | --- |
| 422 | `input` | `invalid_body` / `missing_field` / `invalid_price` / `invalid_bps` | 请求体非法、价格为非正整数、bps 越界 |
| 422 | `input` | `unknown_collection` / `unknown_token` / `unknown_order` / `unknown_user` | 引用的资产/订单/用户不存在 |
| 409 | `state` | `duplicate_listing` | 同一 token 已有有效挂单 |
| 409 | `state` | `order_not_open` | 订单已成交/已取消（取消或成交已结订单） |
| 409 | `state` | `not_order_creator` | 非创建者取消 |
| 409 | `state` | `seller_not_owner` | 成交时卖方已不再持有该 token（挂单随即失效转为 cancelled） |
| 409 | `state` | `insufficient_balance` | 买方余额不足 |
| 409 | `policy` | `soulbound_transfer` | soulbound collection 的挂单/成交，**与 state 类冲突可区分** |
| 503 | `resource` | `storage_unavailable` / `lock_timeout` | 存储不可用、锁等待超时 |
| 500 | `internal` | `conservation_violation` / `unexpected` | 守恒断言失败（事务整体回滚）/ 未预期错误 |

## 核心语义

- **原子结算**：所有权转移、买方扣款、版税与卖方入账在同一 `BEGIN IMMEDIATE` 事务内提交；任一守恒断言失败即整体回滚并返回 500。
- **并发裁决**：并发 accept 由 SQLite 写锁串行化，以事务内单调递增的 `commit_seq`（提交序号）裁决，不依赖请求到达时间戳；恰有一个成功，其余得到 `409 order_not_open`。
- **版税拆分**：`royalty = floor(price × bps / 10000)`，卖方得 `price − royalty`，买方实付恒为 `price`。拆分配置取**挂单创建时**的 collection 快照，事后修改 collection 不影响已挂订单；成交响应与 `fills` 表记录来自同一提交快照。
- **守恒不变量**：任意时刻 `Σ余额变动 = 0`、`royalty + sellerProceeds = price`；`/diag/health` 校验全账本余额总和等于种子期望值。
- **soulbound**：服务端在挂单与成交两个入口强制拒绝，返回 `policy/soulbound_transfer`（409，与普通状态冲突的 `state` 类别可区分）。

## 复现步骤

```bash
npm install
npm test         # 24 个测试：状态机边界 / 版税非整除(1003@250bps→25/978) / 并发双买家与三方竞速 / soulbound / 错误分类(422/409/503/500)
npm run accept   # 14 个场景顺序演练，逐步打印请求/响应/PASS-FAIL，全部通过退出 0
```

测试中的期望值（如 royalty=25、sellerProceeds=978）为手工计算的常量字面量，并辅以独立重算交叉验证，不由被测实现生成。
