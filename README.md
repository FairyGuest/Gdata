# audit-chain-a — 防篡改审计日志服务

基于 SHA-256 哈希链的只增审计日志。每条记录包含前一条记录的哈希，任何对历史内容的修改、删除或重排都会在验证时被定位到首次断裂的序列号。

## 技术栈与依赖

- Node.js >= 20（开发验证使用 v24）
- TypeScript 5.9、Fastify 4.29、better-sqlite3 13.0（SQLite）
- 完整版本清单见 `package.json`；全部依赖为公开 npm 包，无需任何生产账号或真实业务数据

## 快速开始（干净目录复现）

```powershell
npm install
npm test        # 编译并运行全部单元/接口测试
npm run accept  # 一键验收：按固定顺序演练全部场景，全部通过退出 0
npm start       # 启动服务（默认 0.0.0.0:3000，数据库文件 audit.db）
npm run demo    # 本地演示：向 demo.db 追加 3 条样例事件并验证
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUDIT_DB` | `audit.db` | SQLite 文件路径，`:memory:` 表示内存库 |
| `AUDIT_MAX_EVENTS` | `1000000` | 容量上限，超过后追加返回 507 |

## HTTP 接口

- `POST /events` — 追加事件。请求体：`{"actor":"alice","action":"create","resource":"doc-1","metadata":{...}}`，`metadata` 可选。成功返回 `201` 与完整条目（含 `seq`、`timestamp`、`prevHash`、`hash`）。
- `GET /events?limit=&offset=` — 按序列号升序分页查询。
- `GET /verify` — 从第一条开始逐级校验哈希链，返回 `{ ok, length, brokenAt?, code?, reason? }`。
- `GET /diagnostics` — 诊断信息：条目数、链尾 `{seq, hash}`、创世哈希。
- `GET /health` — 存活探针。

### 请求样例

```powershell
curl -X POST http://127.0.0.1:3000/events -H "content-type: application/json" `
  -d '{"actor":"alice","action":"create","resource":"doc-1"}'
curl http://127.0.0.1:3000/verify
```

## 哈希链规则

- 哈希 = `SHA-256(规范化JSON({seq, timestamp, prevHash, actor, action, resource, metadata}))`，键按字典序排序，写入时即计算并落库。
- 第一条的 `prevHash` 为 64 个 `0`（创世哈希）。
- 序列号从 1 开始严格递增、无跳号；追加在 SQLite 事务内完成，已写入条目不提供任何修改/删除接口。

## 验证结果与错误语义

### `GET /verify` 失败类别（`code` 字段）

| code | 含义 |
| --- | --- |
| `HASH_MISMATCH` | 条目内容被篡改，存储哈希与重算哈希不一致 |
| `PREV_HASH_MISMATCH` | 与前一条的哈希链接被改接 |
| `SEQUENCE_GAP` | 序列号出现间隙（条目被删除或跳号），`brokenAt` 为首个缺失位置 |

`brokenAt` 始终指向首次断裂的序列号；`reason` 给出人类可读的判断理由。

### HTTP 错误类别（`error.kind` 字段）

| kind | HTTP 状态 | 触发条件 |
| --- | --- | --- |
| `VALIDATION` | 400 | 请求体缺少必填字段或类型不符 |
| `STATE_CONFLICT` | 409 | 数据库约束冲突 |
| `RESOURCE_EXHAUSTED` | 507 | 达到容量上限或磁盘耗尽 |
| `COMPUTATION_FAILURE` | 500 | 哈希计算失败 |
| `INTERNAL` | 500 | 其他未预期错误 |

任何异常或未知状态都不会被统一包装成成功响应。

## 防篡改验证（复现步骤）

`npm run accept` 在临时目录创建真实 SQLite 库并启动服务，按固定顺序演练：

1. **完整链通过**：追加 3 条事件，`GET /verify` 返回 `{ ok: true, length: 3 }`。
2. **篡改定位**：直接 `UPDATE audit_events SET action='forged' WHERE seq=2`，`GET /verify` 返回 `ok:false, brokenAt:2, code:HASH_MISMATCH`。
3. **间隙检测**：`DELETE FROM audit_events WHERE seq=2`，`GET /verify` 返回 `ok:false, brokenAt:2, code:SEQUENCE_GAP`。
4. **输入校验**：缺字段的追加返回 `400` 且 `error.kind=VALIDATION`。
5. **诊断一致**：`GET /diagnostics` 的 `count`/`head` 与当前链状态一致。

每步打印请求、响应与 `[PASS]/[FAIL]` 判定；全部通过退出码 0，任一步失败退出码非 0 并列出失败场景名。

手工复现篡改场景：启动服务后追加若干事件，用任意 SQLite 客户端修改或删除 `audit_events` 表中的行，再访问 `GET /verify` 即可看到断裂位置。

## 测试

`npm test` 实际执行 13 个测试（`node --test`），断言具体结果与失败类别：

- 独立参考向量：固定输入的哈希值与**由 .NET SHA256 独立计算**的参考值 `85998984…96dcb9` 比对，而非由被测实现自身生成。
- 完整链通过、篡改中间条目定位（`HASH_MISMATCH`）、删除条目间隙（`SEQUENCE_GAP`）、伪造链接（`PREV_HASH_MISMATCH`）、空链。
- 接口级：追加/查询/验证、非法输入 400、容量上限 507、对真实 SQLite 文件篡改与删除后的 `/verify` 定位。

测试输出包含 `[run=...]` 运行标识与关键中间状态（哈希、断裂位置、判断理由），可用于重放问题。

## 代码结构

```
src/
  contract/   类型、JSON Schema、错误契约（errors.ts）
  core/       执行内核：规范化、哈希计算、链验证（chain.ts）
  state/      状态适配：SQLite 存储与错误映射（store.ts）
  http/       诊断与业务接口：Fastify 路由与错误处理（server.ts）
  config.ts   配置层（环境变量解析）
  index.ts    服务入口
test/         单元与接口测试
scripts/      accept.ts（一键验收）、demo.ts（本地演示）
```
