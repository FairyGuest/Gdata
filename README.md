# NFT 电子门票本地服务

使用 TypeScript、Node.js、Fastify 与 SQLite 实现的最小可验收电子门票系统。所有场次、座位、用户和余额均由固定本地种子生成，不依赖真实账号、时钟或网络时序。

## 快速开始

```bash
npm install
npm run accept
```

`npm run accept` 按固定顺序执行并发抢座、限购释放、转让、退票、检票和输入契约场景，逐步打印运行编号、请求、响应、期望和判定；全部通过退出码为 0，任一失败退出码非 0。

其他命令：

- `npm run typecheck`：执行 TypeScript 严格类型检查。
- `npm start`：在 `127.0.0.1:3000` 启动 Fastify；默认使用内存 SQLite。
- `SQLITE_FILE=./ticketing.db npm start`：使用本地 SQLite 文件。

## 固定夹具

- 场次：`evt-1`，票价 5000 分，每人限购 2 张。
- 座位：`A-1`、`A-2`；验收中会在独立账本临时加入 `A-3` 验证超限。
- 用户与余额：`alice`、`bob`、`carol`，各 10000 分。

## HTTP 接口

- `POST /tickets/purchase`：`{ runId, eventId, seatId, userId }`
- `POST /tickets/transfer`：`{ runId, ticketId, userId, toUserId }`
- `POST /tickets/refund`：`{ runId, ticketId, userId }`
- `POST /tickets/check-in`：`{ runId, ticketId, userId }`
- `GET /diagnostics/tickets/:ticketId`：票状态、当前持有者和归属历史。
- `GET /diagnostics/seats/:eventId/:seatId`：座位有效票数。
- `GET /diagnostics/users/:userId`：用户余额。

票实例 ID 形如 `ticket:evt-1:A-1:v1`。座位退票后可重新发售，新票使用新版本号，历史票实例和流水仍可追踪。

## 事务与并发

购票在同一个 SQLite 事务中完成：

1. 校验场次、座位和用户。
2. 显式查询座位是否已有非退票有效票，冲突返回 `seat_held`，不依赖唯一索引报错作为业务判断。
3. 显式统计用户在该场次的非退票有效票数，超限返回 `purchase_limit_reached`。
4. 校验余额并扣款。
5. 写入 `commit_log`，以事务内提交序号 `commitSeq` 作为裁决记录。
6. 写入票、出票历史和余额流水，并维护 `active_seats` 占位表。

请求中的 `runId` 只用于日志和流水重放识别，不用到达时间戳裁决抢座。

## 票状态机

有效票状态为 `sold`，可转让或退票；检票后为终态 `checked_in`；退票后为 `voided`，释放座位和限购额度。

- 只有当前持有者可以转让、退票或检票。
- `checked_in` 是终态，不能转让、退票或重复检票。
- `voided` 不能转让或检票。
- 检票只更新票状态，不修改既有归属记录；检票动作单独追加历史。

## 错误语义

响应统一为：

```json
{ "error": { "reason": "machine_readable_reason", "message": "human readable message" } }
```

- 422 `invalid_input`：参数缺失、空字符串或运行编号不是非负整数。
- 409 `seat_held`：座位已有有效票。
- 409 `purchase_limit_reached`：超过每人每场上限。
- 409 `insufficient_balance`：余额不足。
- 409 `not_holder`：操作者不是当前持有者。
- 409 `already_checked_in`：已检票终态冲突或重复检票。
- 409 `voided`：已退票票发生转让或检票等冲突。
- 503 `database_busy`：SQLite 锁等待耗尽。
- 503 `storage_exhausted`：SQLite 存储或文件资源耗尽。
- 500 `compute_failed`：未预期计算失败；不会伪装为成功。

不存在的场次、座位、用户或票分别返回 404：`event_not_found`、`seat_not_found`、`user_not_found`、`ticket_not_found`。

## 工程结构

- `src/contract/`：参数解析、请求类型和错误契约。
- `src/kernel/`：售票用例执行内核。
- `src/state/`：SQLite 迁移、账本、余额、票状态和限购计数。
- `src/diag/`：票、座位和用户只读诊断模型。
- `src/http/` 与 `src/app.ts`：Fastify 路由和应用装配。
- `acceptance/`：独立固定顺序验收程序和具体 reason 断言。
