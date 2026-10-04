# NFT 固定价挂单市场

本地合成、零外部账号依赖的 TypeScript / Node.js / Fastify / SQLite NFT 固定价市场。系统支持挂单、创建者取消、买家成交、按比例版税拆分，并由服务端强制拒绝 soulbound 资产交易。

## 依赖清单

- Node.js 24+（使用内置 `node:sqlite`，无需第三方 SQLite 原生模块）
- Fastify 5
- TypeScript 5
- tsx（直接运行 TypeScript）
- @types/node

安装依赖：

```bash
npm install
```

## 一键验收

```bash
npm run accept
```

验收脚本使用固定种子的内存账本，按固定顺序执行并逐步打印：

- 请求方法、路径、请求体
- 响应状态码、完整响应体
- 运行编号 `run-xxxx`、订单状态转移、内部提交序号
- 成交价、版税、卖方到账、买方扣款与流水
- 每个具体判定的 `PASS/FAIL` 与判断依据

全部场景通过时退出码为 `0`；任一断言失败时退出码非 `0`，并输出 `FAILED SCENARIO: ...`。每次验收还会把终态诊断事件写入 `artifacts/acceptance/diag.jsonl`。

独立测试：

```bash
npm test
```

类型检查：

```bash
npm run typecheck
```

## 启动 HTTP 服务

```bash
npm start
```

默认监听 `127.0.0.1:8080`。可用环境变量：

- `PORT`：监听端口，默认 `8080`
- `HOST`：监听地址，默认 `127.0.0.1`
- `DB_PATH`：SQLite 文件路径，默认 `:memory:`
- `LOCK_WAIT_MS`：SQLite 写锁等待时间，默认 `5000`
- `DIAG_LOG_PATH`：诊断 JSONL 输出路径，默认不落文件
- `DIAG_CONSOLE=false`：关闭控制台诊断输出

## 固定合成种子

种子定义在 `src/fixtures/seed-fixture.ts`，包含用户余额、collection、token 所有权和一个 seeded soulbound active order。核心初始数据：

- 用户：`u-alice`、`u-bob`、`u-carol`、`u-dave`、`u-broke`、`u-treasury`、`u-soul-treasury`
- `col-art`：普通 collection，初始 `royaltyBps=250`，收款方 `u-treasury`
- `col-soul`：soulbound collection，`soulbound=true`，收款方 `u-soul-treasury`
- `col-zero-royalty`：零版税普通 collection
- `tok-royalty`、`tok-concurrent`、`tok-cancel`、`tok-move` 等普通代币初始属于 `u-alice`

不依赖真实时钟、网络参与者、外部链或生产账号。验收中的所有权转移通过本地管理控制接口模拟，仅用于固定场景复现。

## API

### 创建挂单

`POST /orders/listings`

```json
{
  "collectionId": "col-art",
  "tokenId": "tok-royalty",
  "sellerId": "u-alice",
  "price": 1003
}
```

成功返回 `201`。挂单创建时复制 collection 的版税 bps、版税收款方和 soulbound 快照到订单；之后修改 collection 不影响该订单。

### 取消订单

`POST /orders/:orderId/cancel`

```json
{ "requesterId": "u-alice" }
```

只有订单创建者可以取消；已成交或已取消订单不能取消。

### 买家成交

`POST /orders/:orderId/accept`

```json
{ "buyerId": "u-bob" }
```

成交事务中重新读取订单状态、token 持有人和买方余额。所有权转移、买方扣款、版税入账、卖方入账和订单终态更新由同一个 SQLite 事务提交。

版税规则：

```text
royalty = floor(price * bps / 10000)
sellerProceeds = price - royalty
buyerPaid = price
```

非整除例子：`price=1003`、`bps=250` 时，`royalty=25`、卖方得 `978`、买方支付 `1003`。

### 查询与诊断

- `GET /orders`：订单簿
- `GET /users`：余额
- `GET /tokens/:collectionId/:tokenId`：当前所有权
- `GET /diag/runs`：终态诊断事件
- `GET /diag/runs/:runId`：按运行编号查询
- `GET /diag/commits`：内部提交序号日志
- `GET /diag/transfers?orderId=...`：成交拆账流水

### 本地合成控制接口

- `POST /admin/collections/:collectionId/royalty`：修改当前 collection bps，用于验证订单快照隔离
- `POST /admin/tokens/:collectionId/:tokenId/transfer`：确定性转移 token，用于验证卖方不持有场景
- `POST /admin/faults/storage-unavailable`：模拟存储不可用
- `POST /admin/faults/conservation-failure`：触发守恒断言失败

这些接口只面向本地验收/测试夹具，不代表生产授权模型。

## 错误语义

统一响应形状：

```json
{
  "error": {
    "category": "state",
    "reason": "conflict.order_already_filled",
    "message": "Order has already been filled",
    "details": { "orderId": "ord-000001" }
  }
}
```

| HTTP | category | reason | 场景 |
| --- | --- | --- | --- |
| 422 | `input` | `input.missing_field` | 缺少非空字符串字段 |
| 422 | `input` | `input.bad_type` | 请求体不是对象等形状错误 |
| 422 | `input` | `input.price_not_positive_integer` | 价格不是正安全整数 |
| 422 | `input` | `input.bps_out_of_range` | bps 不在 `0..10000` |
| 422 | `input` | `input.unknown_collection` | collection 不存在 |
| 422 | `input` | `input.unknown_token` | token 不存在 |
| 422 | `input` | `input.unknown_order` | 订单不存在 |
| 422 | `input` | `input.unknown_user` | 用户不存在 |
| 409 | `state` | `conflict.duplicate_listing` | 同一 token 已有 active 挂单 |
| 409 | `state` | `conflict.order_already_filled` | 订单已成交；并发失败方也是此 reason |
| 409 | `state` | `conflict.order_already_cancelled` | 订单已取消 |
| 409 | `state` | `conflict.not_order_creator` | 非创建者取消 |
| 409 | `state` | `conflict.seller_not_holder` | 成交时卖方不再持有 token |
| 409 | `state` | `conflict.insufficient_balance` | 买方余额不足 |
| 409 | `policy` | `policy.soulbound_listing` | soulbound 资产挂单被服务端拒绝 |
| 409 | `policy` | `policy.soulbound_accept` | soulbound 资产成交被服务端拒绝 |
| 503 | `resource` | `resource.storage_unavailable` | 存储不可用 |
| 503 | `resource` | `resource.lock_timeout` | SQLite 写锁等待超时 |
| 500 | `computation` | `computation.conservation_violation` | 守恒断言失败 |
| 500 | `computation` | `computation.integer_overflow` | 整数算术越界 |
| 500 | `computation` | `computation.unexpected` | 未分类计算/未知失败 |

soulbound 使用独立 `category=policy` 和独立 reason，不与重复挂单等普通状态冲突混淆。

## 并发裁决与原子性

每个写事务执行 `BEGIN IMMEDIATE`，并在事务开始时递增库内 `commit_sequence.value`。并发双 accept 都进入服务后，只有条件更新 `WHERE id=? AND status='active'` 能把订单状态更新一行的事务可以成功提交；另一个事务在自己的 SQLite 快照中看到订单已成交并回滚，返回 `409 conflict.order_already_filled`。

裁决依据是内部事务提交序号和条件更新结果，不使用请求到达时间戳。成功响应里的新所有者、成交价和拆账金额来自同一事务提交快照。

成交写入三类流水：

- 买方 `debit`：金额 `price`
- 卖方 `credit`：金额 `price - royalty`
- 版税收款方 `credit`：金额 `royalty`

因此每笔成交都满足：

```text
sum(debits) = sum(credits) = price
royalty + sellerProceeds = price
sum(all balances before) = sum(all balances after)
token count before = token count after
```

状态层在订单终态更新前执行所有权和余额变更、流水写入及守恒检查；所有语句仍处于同一个 SQLite 事务，任何失败均整体回滚，不会出现“订单已成交但账本未平”的已提交状态。

## 代码边界

- `src/contract/`：请求解析、正整数价格、bps、资产/用户/订单存在性校验
- `src/kernel/`：挂单/取消/成交用例、版税纯算术、守恒断言、策略判定
- `src/state/`：SQLite 迁移、固定种子、所有权/余额/订单簿/快照/提交日志适配器
- `src/diag/`：运行编号、状态转移、拆账明细、判定依据与 JSONL sink
- `src/routes/`：Fastify HTTP 路由和错误状态码映射
- `src/fixtures/`：固定本地合成种子
- `test/`：独立 `node:test` 断言
- `acceptance/`：固定顺序一键验收脚本

## 已验证场景

- 并发双买家 accept：恰有一个 `200`、一个 `409`，所有权只转移一次，余额总和不变
- `price=1003`、`bps=250`：独立 BigInt 期望值与服务结果均为 `royalty=25`、卖方 `978`
- 挂单后修改 collection bps：已存在订单仍使用创建时快照
- soulbound：挂单和 seeded order 成交均被拒绝，类别为 `policy`，reason 可区分
- 重复挂单、非创建者取消、成交后取消、取消后再取消：reason 全部可区分
- 卖方成交前转出 token：返回 `conflict.seller_not_holder`，无余额副作用
- 余额不足：返回 `conflict.insufficient_balance`
- 输入错误：价格、bps、未知 collection/token/order/user 返回 422
- 存储不可用和真实 SQLite 外连接写锁：返回 503 且 reason 可区分
- 守恒断言失败：返回 500 `computation.conservation_violation`，诊断记录保留原因
