# secrets-vault

版本化加密密钥保险库：每次写入产生新版本（旧版本仍可读取），支持轮换（旧版本进入宽限期，到期后不可读），每次读写都在**同一事务**中写入不可篡改的审计日志。时间通过注入的 `Clock` 控制（测试/验收用 `VirtualClock`，服务用 `SystemClock`）。

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 22.6（开发用 24.x） | 运行时（原生 `--experimental-transform-types` 运行 TS） |
| fastify | 4.29.1 | HTTP 契约层 |
| better-sqlite3 | 13.0.3 | 状态适配层（事务、审计不可变触发器） |
| typescript | 5.9.3 | 类型检查（`npm run typecheck`） |
| @types/node | 20.19.43 | 类型 |

加密：AES-256-GCM（`node:crypto`），每次加密使用随机 12 字节 IV，写入前加密、读出后解密，密文/IV/AuthTag 以 base64 落库。

## 架构（模块边界）

- `src/clock.ts` — 时间契约：`Clock` 接口、`SystemClock`、`VirtualClock`
- `src/errors.ts` — 错误契约：`VaultError` + 错误码 → HTTP 状态映射
- `src/crypto.ts` — `AesGcmCipher`：encrypt/decrypt，失败抛 `CRYPTO_ERROR`
- `src/store.ts` — 状态适配：SQLite schema、事务（业务+审计同一事务）、审计不可变触发器
- `src/core.ts` — 执行内核：输入校验、版本化写、读（含宽限期判定）、轮换
- `src/server.ts` — 契约解析/诊断接口：Fastify 路由、统一错误响应、`/healthz`
- `src/config.ts` — 配置层：env/默认值/主密钥生成与持久化
- `src/index.ts` — 服务入口
- `test/` — 独立测试层；`scripts/accept.ts` 一键验收；`scripts/demo.ts` 本地演示

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `VAULT_DB_PATH` | `./data/vault.db` | SQLite 路径（`:memory:` 可用） |
| `VAULT_MASTER_KEY` | 自动生成并持久化到 `<db>.key` | 64 位十六进制（32 字节）主密钥 |
| `VAULT_GRACE_MS` | `60000` | 轮换宽限期（毫秒） |
| `VAULT_RUN_ID` | `run-<uuid>` | 运行编号，写入每条审计与日志 |

## API 与请求样例

```
PUT  /secrets/:name        {"value":"s3cr3t"}   -> {"statusCode":201,"data":{"name","version"}}
GET  /secrets/:name?version=N                    -> {"name","version","value","createdAt","graceUntil"}
POST /secrets/:name/rotate                       -> {"name","version","graceUntil"}
GET  /secrets/:name/versions                     -> {"versions":[...]}（不含密文）
GET  /audit?name=<name>                          -> {"entries":[...]}
GET  /healthz                                    -> {"status","runId","now","counts"}
```

调用方可用请求头 `x-actor` 标识操作者（写入审计）。示例：

```bash
curl -X PUT localhost:8787/secrets/db.password -H 'content-type: application/json' -d '{"value":"v1"}'
curl localhost:8787/secrets/db.password?version=1
curl -X POST localhost:8787/secrets/db.password/rotate
```

## 错误语义

统一错误响应：`{"error":{"code","message","details?"}}`。任何错误都不会被吞掉或统一返回成功。

| code | HTTP | 类别 | 含义 |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | 输入错误 | 名称/值/版本号/主密钥格式不合法 |
| `SECRET_NOT_FOUND` | 404 | 状态 | 密钥不存在 |
| `VERSION_NOT_FOUND` | 404 | 状态 | 版本不存在 |
| `VERSION_EXPIRED` | 410 | 状态冲突 | 版本存在但宽限期已过（判定：`now >= graceUntil`，恰到期即过期） |
| `CONFLICT` | 409 | 状态冲突 | 无可读版本等状态冲突 |
| `STORAGE_ERROR` | 500 | 资源/存储 | SQLite 故障（含资源耗尽） |
| `CRYPTO_ERROR` | 500 | 计算失败 | 加解密/认证失败（如密文被篡改） |
| `AUDIT_ERROR` | 500 | 审计 | 审计写入失败，业务操作已回滚 |
| `INTERNAL_ERROR` | 500 | 未分类 | 其他未知异常 |

宽限期语义：轮换后旧版本 `graceUntil = 轮换时刻 + VAULT_GRACE_MS`；`now < graceUntil` 可读（兼容消费者切换），`now >= graceUntil` 返回 `VERSION_EXPIRED`；最新版本永不过期。

审计：每次读/写/轮换恰好产生一条审计（含 `runId`、时间、actor、动作、版本、success/failure、错误码），与业务效果在**同一 SQLite 事务**提交；`UPDATE`/`DELETE` 被数据库触发器拒绝（append-only）。

## 复现步骤（干净目录）

```bash
npm install          # 或复制依赖清单中的 node_modules
npm run typecheck    # 类型检查
npm test             # 17 个独立测试（多版本读写/宽限期恰到期/审计不可变/加密往返等）
npm run accept       # 一键验收：5 场景按序演练，打印每步请求/响应/判定，全过退出 0
npm start            # 启动服务（127.0.0.1:8787）
npm run demo         # 端到端演示（真实 HTTP + 系统时钟，2s 宽限期）
```

最近一次执行结果（本机 Node v24.14.1）：

- `npm test`：17 pass / 0 fail
- `npm run accept`：`ALL 5 CHECKS PASSED`，退出码 0
- `npm run demo`：轮换后宽限期内旧版本 200，宽限期过后 `VERSION_EXPIRED`，审计完整

## 测试与验收说明

- 测试断言具体值与失败类别（如 `VERSION_EXPIRED` 恰在 `graceUntil` 触发、篡改密文抛 `CRYPTO_ERROR`、审计删除被拒后行数不变）。
- 加解密正确性使用**独立生成的参考向量**（固定 key/IV/明文经 `node:crypto` 一次性生成的期望密文，硬编码于 `test/crypto.test.ts`），不由被测实现自证。
- 验收脚本覆盖：多版本写入与读取 → 轮换宽限期（含恰到期边界）→ 审计完整性与不可变 → 加密往返与篡改检测 → 错误分类；每步打印请求、响应与判定理由，任一失败非 0 退出并指出场景编号。
- 所有日志/审计携带 `runId`，可按运行编号重放定位问题。
