# NFT 抵押借贷服务（最小可验收实现）

借入即把 NFT 锁入托管、利息按内部 **tick** 累计、支持恰额赎回与跌破估值线清算，全程账本守恒。
技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需原生编译）+ Fastify。

## 一键验收

```bash
npm install
npm run accept      # 固定顺序演练全部场景；全通过退出 0，任一失败非 0 并指出失败场景
```

验收脚本 `test/accept.ts` 通过 Fastify 内存注入（in-process inject）打一个
**内存 SQLite**（固定种子夹具），逐步打印每个请求、响应与 [PASS]/[FAIL] 判定，
末尾打印按内部提交序号排序的 commit log，可凭 runId / tick / seq 重放问题。
它不使用真实时钟或网络时序。

类型检查：`npx tsc -p tsconfig.json --noEmit`。启动 HTTP 服务：`npm start`
（默认 127.0.0.1:4731，可用 `NFT_LOAN_PORT` 等环境变量覆盖，见 `src/config.ts`）。

## 目录与模块边界

- `src/contract/` — 参数解析与错误契约。`parser.ts` 校验金额（正整数）、
  标识符、费率 bps（0–10000）；`errors.ts` 定义分类错误与独立 reason；`types.ts` 定义命令/视图。
- `src/kernel/` — 借贷内核。`money.ts` 为纯整数算术（BigInt，精确下取整、交叉相乘比较）；
  `kernel.ts` 负责借/还/清算业务规则、事务边界与“先认领（CAS）后转移”的提交序号裁决。
- `src/state/` — SQLite 适配。`sqlite.ts` 封装 `node:sqlite`（IMMEDIATE 事务、busy 重试）；
  `schema.ts` 建表迁移；`ledger.ts` 是余额/借款单/托管所有权/估值阶梯/commit_log 的读写；
  `fixtures.ts` 是固定种子（余额 + NFT 持有者 + 按 tick 的估值阶梯，绝无随机或外部拉取）。
- `src/diag/queries.ts` — 只读诊断：借款单状态、当前结算量、系统全量状态与提交日志。
- `src/app.ts` / `src/server.ts` — Fastify 路由装配与进程入口；`src/config.ts` 为配置层。

## 数据模型（守恒对象）

- `balances(account, amount)`：现金账本，带 `amount >= 0` 约束。
- `nfts(token_id, holder)`：每个 NFT 恰有一个持有者；借款成功后 holder=`escrow`，
  还款赎回给借款人，清算转给资金方 `lender-pool`。
- `valuation_tiers(token_id, start_tick, value)`：估值阶梯表，按
  `start_tick <= 当前 tick` 的最大一行取值。
- `loans(...)`：`active/repaid/liquidated` 三态，记录 `opened_tick`、
  `settled_tick` 与裁决用的 `settle_commit_seq`。
- `meta`：全局单调 `tick` 与 `commit_seq`。
- `commit_log`：每次成交/状态冲突都留痕（seq、run_id、tick、action、result、reason、detail）。

## 逻辑时间与利息

- 全局 `tick` 从 0 单调递增；**每笔成交的写请求（借/还/清算成功）使其 +1**。
  校验失败的请求回滚，不推进 tick；对已了结单据的重复操作记为一次“冲突提交”，
  只追加 commit_seq，不推进 tick。
- 已过 tick = 结算 tick − 借入 tick；估值取结算 tick 所在阶梯值。
- 应付 = 本金 + floor(本金 × perTickBps × 已过 tick / 费率分母)，BigInt 整除精确下取整。

> 关于利息分母的说明：任务文字写“/10000”，但给定的强制算例是
> 本金 1003、perTickBps 5、7 tick → floor(35.105)=35、应付 1038。
> 由于 1003×5×7=35105，要得到 35.105，利息费率分母必须是 **1000**；
> 若按 10000 分母只会得到 floor(3.5105)=3。验收以给定数字（35 / 1038）为准，
> 故利息采用分母 1000（常量 `INTEREST_RATE_DENOMINATOR`）；而质押率与清算线的
> bps 比较仍使用标准分母 10000（如质押率 8000bps=80%）。两处分母在
> `src/kernel/money.ts` 中以具名常量显式区分。

## 业务规则

- 借入：借款人必须持有该 NFT；需满足
  金额 ≤ floor(当前估值 × 质押率bps / 10000)，且资金池余额充足。
  放款、建单、NFT 转托管在**同一个 IMMEDIATE 事务**内提交，否则回滚。
- 还款：金额 ≥ 应付才成交；多还部分（找零）在同事务退回付款人，抵押同事务赎回给借款人。
- 清算：当 **当前估值 < 应付 × 清算线bps / 10000**（严格小于）时任何人可清算：
  先对 `active` 借款做原子 CAS（`UPDATE ... WHERE status='active'`）认领，
  认领成功后才在**同一事务内**转移抵押并销账。绝不是“先转质押再记台账”。

### 并发裁决

两个清算并发时，SQLite 的 IMMEDIATE 写锁使事务按提交顺序串行化；
每个成功认领写入自己的 `commit_seq`，CAS 保证恰有一个把单据从 active 改为终态。
负者读到的已是终态，返回 409 且响应/日志带 `winnerCommitSeq`（严格小于负者 seq）。
裁决只依据内部提交序号，不依据到达时间戳。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/loans/borrow` | body: `{borrower, tokenId, amount}` |
| POST | `/loans/:id/repay` | body: `{payer, amount}` |
| POST | `/loans/:id/liquidate` | body: `{liquidator}` |
| GET  | `/loans/:id` | 借款单状态 + 当前结算量（活动中） |
| GET  | `/diag/state` | tick、余额、NFT 托管、全部借款单、commit log |
| GET  | `/health` | 健康检查 |

成功响应：`{ok:true, runId, tick, commitSeq, action, loanId, data}`。
失败响应统一信封：`{ok:false, runId, error:{category, reason, message, detail}}`。

## 错误语义（HTTP 与独立 reason）

| HTTP | category | 独立 reason | 触发 |
| --- | --- | --- | --- |
| 422 | input | `invalid_field` | 非整数金额、非法 id、非数字 loanId 等 |
| 422 | input | `amount_out_of_range` | 金额 ≤0 或超安全整数范围 |
| 422 | input | `bps_out_of_range` | bps 不在 0–10000 |
| 409 | conflict | `insufficient_collateral` | 超额借入（金额 > 估值×质押率） |
| 409 | conflict | `repayment_too_small` | 还款不足应付 |
| 409 | conflict | `liquidation_line_not_crossed` | 估值未跌破清算线 |
| 409 | conflict | `loan_already_settled` | 对已还款/已清算单据再操作（含并发负者） |
| 409 | conflict | `loan_not_found` | 借款单不存在 |
| 409 | conflict | `nft_not_held` | 借款人不持有抵押 NFT |
| 409 | conflict | `insufficient_liquidity` | 资金池余额不足 |
| 503 | resource | `resource_busy` | 写锁获取在有限重试后仍失败 |
| 500 | computation | `computation_failed` | 无估值阶梯、负 tick、余额/NFT 不可能状态等内部不变量破坏 |

异常或未知错误不会被统一成成功：未预期异常一律 500 `computation_failed`。

## 验收场景（固定顺序）

1. 利息非整除：1003×5×7，内核结果与**测试内独立 oracle**（自写循环 + BigInt 整除）
   双双等于 35、应付 1038；另验 5.015→5；bps 越界报输入错误。
2. 在估值 1000 时以 NFT-DELTA 借入 800（该 NFT 在 tick≥10 跌到 700）。
3. 质押边界：借 1000 → 409 `insufficient_collateral`（maxAmount=800），失败不改任何状态；
   恰额 800 成功并托管。
4. tick 3 借入 1003（NFT-GAMMA），再用 6 笔小额借入把全局 tick 推到 9。
5. 还款边界：tick 10 结算利息 35/应付 1038；还 1037 → 409 `repayment_too_small` 且回滚；
   还 1040 成交、找零 2、NFT 赎回；再次还款 → 409 `loan_already_settled`。
6. 并发双清算同一借款：`Promise.all` 同时发两笔，断言恰一个 200、一个 409，
   抵押仅转给资金方一次，负者带更小的 `winnerCommitSeq`；第三笔仍 409。
7. 健康借款清算 → 409 `liquidation_line_not_crossed`，单据保持 active。
8. 422 输入错误（负金额/空 id/非数字 loanId/小数金额）reason 可区分。
9. 其余状态冲突（未知借款单、不持有 NFT）reason 可区分。
10. 诊断接口：守恒不变量、commit seq 连续稠密、双清算恰一条 ok 与至少一条 conflict。
11. 最终全局守恒：现金总额恒等于种子合计、NFT 总数不变且每个持有者计数不重不漏。

## 依赖

- 运行时：`fastify`；SQLite 使用 Node 内置 `node:sqlite`（Node ≥ 22.5，开发机为 Node 24），
  因此**无需 better-sqlite3 之类的本地编译工具链**。
- 开发：`typescript`、`tsx`、`@types/node`。

