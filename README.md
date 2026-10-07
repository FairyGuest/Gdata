# env-secrets-binding

环境密钥绑定与注入服务：管理按 **组织 / 项目 / 环境** 三级作用域树声明的密钥，在环境创建时按"最近作用域覆盖"解析出应注入的密钥集合并定版为注入快照。本服务只负责绑定与解析语义，不做加密存储；所有数据均为本地合成夹具。

技术栈：TypeScript + Node.js (>=22) + Fastify 5 + SQLite (better-sqlite3)。

## 目录结构（工程边界）

| 层 | 位置 | 职责 |
|---|---|---|
| 契约 | `src/contracts/types.ts` | 领域类型、错误类别、错误码与 HTTP 状态映射 |
| 配置 | `src/config.ts` | 端口、DB 路径、指纹长度、值大小上限等，环境变量可覆盖 |
| 执行内核 | `src/core/resolver.ts` / `src/core/service.ts` | 纯函数最近作用域解析；编排校验、解析、持久化，抛出分类错误 |
| 状态适配 | `src/state/store.ts` | 唯一懂 SQL 的模块：声明、环境、快照历史，事务与级联 |
| 诊断接口 | `src/http/server.ts` | HTTP 契约解析，错误契约映射，请求日志 |
| 入口 | `src/index.ts` | 组装配置、日志、存储、服务并监听 |
| 测试 | `test/*.test.ts` | 解析器单测、内核语义测试、HTTP 契约测试 |
| 验收 | `scripts/accept.ts` | 一键按固定顺序演练全部场景 |
| 离线安装 | `scripts/install-offline.cjs` | 无网络时从本地 npm 缓存解包依赖 |

## 依赖清单（锁定版本）

运行时：`fastify@5.12.5`、`better-sqlite3@12.11.1`
开发：`typescript@5.9.3`、`tsx@4.23.15`、`@types/node@24.19.0`、`@types/better-sqlite3@7.6.13`

## 复现步骤（干净目录）

```bash
npm install          # 有网络时；或离线环境：npm run setup（从本地 npm 缓存解包）
npm test             # 编译并执行全部单元/契约测试（17 个）
npm run accept       # 一键验收：固定顺序演练全部场景，全过退出 0，否则非 0
npm start            # 启动服务，默认 127.0.0.1:8080
```

配置项（环境变量）：`ESB_HOST`、`ESB_PORT`、`ESB_DB_PATH`（默认 `data/secrets.db`）、`ESB_LOG_FILE`（默认 `logs/service.log`）、`ESB_FINGERPRINT_LENGTH`（默认 12）、`ESB_MAX_VALUE_BYTES`（默认 4096）、`ESB_MAX_SECRETS_PER_ENV`（默认 256）。

## 请求样例

```bash
# 三级声明同名密钥
curl -X PUT localhost:8080/orgs/acme/secrets/API_TOKEN                              -H 'content-type: application/json' -d '{"value":"org-token-v1"}'
curl -X PUT localhost:8080/orgs/acme/projects/web/secrets/API_TOKEN                 -H 'content-type: application/json' -d '{"value":"proj-token-v1"}'
curl -X PUT localhost:8080/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN -H 'content-type: application/json' -d '{"value":"env-token-v1"}'

# 创建环境：解析并定版注入快照（required 中的名字必须在某层声明过）
curl -X POST localhost:8080/orgs/acme/projects/web/environments -H 'content-type: application/json' -d '{"env":"prod","required":["API_TOKEN"]}'

# 脱敏查询：只有名字、生效层级、来源路径、值指纹，绝不回传明文
curl localhost:8080/orgs/acme/projects/web/environments/prod/secrets

# 绑定关系查询（按环境或密钥名）
curl 'localhost:8080/bindings?name=API_TOKEN'
curl 'localhost:8080/bindings?environmentId=<env-id>'

# 删除被引用的声明 -> 409；删除环境 -> 级联清理快照
curl -X DELETE localhost:8080/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN
curl -X DELETE localhost:8080/orgs/acme/projects/web/environments/prod
```

## 核心语义

- **最近作用域覆盖**：同名密钥 env 层 > project 层 > org 层，逐键独立判定；每项输出生效层级与来源路径（如 `org:acme/project:web/env:prod`）。
- **注入快照**：环境创建时把解析结果（值、指纹、来源声明版本）定版入库；此后上层声明的新增/修改不影响已创建环境，查询返回创建时刻的版本与标记。
- **缺失拒绝**：`required` 中任何层级都未声明的名字 → 400，`details.missing` 列出全部缺名。
- **脱敏**：查询只返回 `name/level/sourcePath/fingerprint/declarationVersion`，指纹为 sha256(值) 前 N 位。
- **删除保护**：声明仍被活跃环境快照引用 → 409，`details.referencedBy` 列出引用方环境；删除环境级联清理其快照后声明方可删除。

## 错误语义

统一错误契约：`{ "error": { "category", "code", "message", "details" } }`。异常与未知状态不会统一返回成功。

| category | HTTP | 含义 | 典型 code |
|---|---|---|---|
| `INPUT_ERROR` | 400 | 请求契约违反：非法段/密钥名/值、引用了未声明的密钥名 | `INVALID_SEGMENT` `INVALID_SECRET_NAME` `INVALID_VALUE` `UNDECLARED_SECRETS` |
| `NOT_FOUND` | 404 | 引用的环境/声明不存在 | `ENVIRONMENT_NOT_FOUND` `DECLARATION_NOT_FOUND` |
| `STATE_CONFLICT` | 409 | 当前状态禁止操作：环境已存在、声明仍被快照引用 | `ENVIRONMENT_EXISTS` `DECLARATION_IN_USE` |
| `RESOURCE_EXHAUSTED` | 413 | 超出限制：值过大、单环境密钥数超限 | `VALUE_TOO_LARGE` `TOO_MANY_SECRETS` |
| `INTERNAL_FAILURE` | 500 | 未预期的内核/适配层故障 | `UNEXPECTED` |

## 日志与可重放性

每次进程启动生成 `runId`，所有日志（JSON 行，写入 `ESB_LOG_FILE`）携带 `runId`、事件名、关键中间状态与判断理由（如 `environment.resolution` 记录每个键的胜出层级、被覆盖声明与"nearest scope wins"理由；`declaration.delete.rejected` 记录引用方）。输入错误、状态冲突、资源耗尽与内部故障在日志与响应中均可区分。验收脚本每步打印请求、响应与判定，并输出证据日志路径。

## 测试

`npm test` 执行 17 个断言具体结果的测试：三级覆盖解析、快照隔离、脱敏（响应体不含明文）、409 删除保护、级联清理、缺失名拒绝、错误类别区分（INPUT_ERROR vs STATE_CONFLICT vs RESOURCE_EXHAUSTED vs NOT_FOUND）。参考指纹为硬编码的 sha256 前缀，非由被测实现生成。

最近一次本地执行结果：`npm test` 17/17 通过；`npm run accept` 16 步全部 PASS（run id 见每次运行输出）。
