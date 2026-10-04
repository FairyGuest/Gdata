# NFT 抵押借贷服务系统

借入即锁定 NFT 作质押托管，利息按内部全局 tick 序号累积，支持恰额赎回与跌破估值线的清算，全程账本守恒。

## 技术栈与依赖

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）
- TypeScript + tsx、Fastify 5、SQLite（内存或文件库）
- 安装：`npm install`

## 一键验收

```
npm install
npm run accept   # 启动真实 HTTP 服务，按固定顺序演练全部场景，全部通过退出 0
npm run test     # 独立单元测试（利息向量、契约校验、内核冲突、守恒）
npm run typecheck
```

`npm run accept` 逐步打印每个场景的请求、响应与判定（PASS/FAIL），任一失败以非 0 退出并指出失败场景。

## 工程结构

- `src/contract/parse.ts` — 借入/还款/清算参数解析；金额为正安全整数，费率 bps 限定 0–10000
- `src/kernel/engine.ts` — 借贷内核：利息算术（BigInt 精确取整）、单事务写边界、提交序号并发裁决
- `src/kernel/errors.ts` — 错误分类契约（kind → HTTP 状态）
- `src/state/db.ts` — SQLite 账本（余额、借款单、托管所有权）、估值阶梯表、迁移与固定种子夹具
- `src/diag/queries.ts` — 借款单状态与结算结果的只读查询
- `src/server.ts` — Fastify 装配与错误映射
- `test/` — 独立测试；`scripts/accept.ts` — 验收演练

## 语义要点

- **逻辑时间**：全局 tick 为单调序号，每笔成功的写请求（借入/还款/清算）在事务内 +1；计息与估值只依赖 tick，不依赖真实时钟。
- **利息**：`debt = principal + floor(principal × perTickBps × elapsedTicks / 1000)`（分母见 `src/config.ts` 的 `INTEREST_DENOMINATOR`；参考向量 principal=1003、perTickBps=5、elapsed=7 → 利息 35、应付 1038）。
- **估值**：只取夹具阶梯表 `valuations` 中 `tick_from <= 当前tick` 的最新一档，不随机、不外部拉取。
- **借入**：`amount×10000 ≤ valuation × 质押率bps`，放款与质押（token 转 `escrow`）在同一 SQLite 事务提交。
- **还款**：`amount ≥ debt` 成交，仅 debt 部分划转资金方，差额同事务留存退回，抵押同事务赎回。
- **清算**：`valuation×10000 < debt × 清算线bps` 时任何人可清算，抵押转资金方、债务消除；并发双清算由 SQLite 事务提交序号裁决——后提交者读到已清算状态而 409，恰有一个成功。

## HTTP 接口

- `POST /borrow` `{borrower, tokenId, amount, perTickBps}`
- `POST /repay` `{loanId, amount, payer}`
- `POST /liquidate` `{loanId, caller}`
- `GET /diag/loan/:id` — 借款单状态、当前 tick 应付债务、当前估值
- `GET /diag/state` — tick、提交序号、全部余额/所有权/借款单与守恒校验

## 错误语义

| 状态 | 类别 | reason（可区分） |
| --- | --- | --- |
| 422 | 输入错误 | `invalid_body` `invalid_field` `invalid_amount` `invalid_bps` |
| 409 | 状态冲突 | `insufficient_collateral` `insufficient_repayment` `insufficient_balance` `already_settled` `not_underwater` `token_not_owned` `token_not_found` `loan_not_found` `account_not_found` |
| 503 | 资源耗尽 | `pool_exhausted` |
| 500 | 计算失败 | `compute_failure`（未知异常一律 500，绝不返回成功） |

响应体统一为 `{ "error": <kind>, "reason": <reason> }`。

## 复现步骤

1. `npm install`
2. `npm run accept` — 场景 S1–S7：夹具守恒、借入托管、超额借入 409、利息向量（1003/5/7→35/1038）、还款不足 409、多还退回 62、重复还款 409、未跌破线清算 409、并发双清算恰一笔 200、输入错误 422、终态守恒。
3. `npm run test` — 单元级断言（含与被测实现独立的 BigInt 对照算术）。
