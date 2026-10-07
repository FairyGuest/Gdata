# preview-env-lifecycle

预览环境即建即用的生命周期服务：从环境模板（服务集合 + 参数默认值）实例化按分支隔离的临时环境，管理创建互斥、存活时限（TTL）与配额池。全部数据使用本地合成夹具，无需任何生产账号。

## 技术栈与运行前提

- TypeScript（Node.js 原生 type-stripping 直接运行，**无需编译、无需安装依赖**）
- Node.js **>= 22.18**（开发验证版本：v24.14.1）
- HTTP 层：Fastify 5（`optionalDependencies`，有网络时 `npm install` 后自动启用）；未安装时自动回退到 API 等价的 `node:http` 适配器，路由表与错误契约完全一致
- SQLite：`node:sqlite` 内置模块（Node 22.5+），零原生依赖
- 测试：`node:test`

> 当前环境离线，依赖清单中 fastify 声明为 optional；`npm install` 不可用时全部功能仍可运行。

## 一键验收

```bash
npm run accept    # 固定顺序演练全部场景，逐步打印请求/响应/判定；全过退出 0，任一失败非 0
npm test          # 22 个单元/生命周期断言测试
npm run demo      # 本地演示脚本（内存库）
npm start         # 启动服务（文件库 data/preview-env.db，端口 4173）
```

最近一次执行结果（2026-10-07，Node v24.14.1）：

- `npm test`：22 passed / 0 failed，退出码 0
- `npm run accept`：19/19 checks passed（S1–S6 全过），退出码 0
- `npm start` 冒烟：`GET /health` 200；`POST /environments` 201 返回 `env-xxxxxxxx`，状态 `deploying`

## 目录结构（工程边界）

| 层 | 文件 | 职责 |
|---|---|---|
| 契约解析 | `src/contract/template.ts` | 模板解析、参数类型校验、默认值合并 |
| 执行内核 | `src/core/lifecycle.ts` | 创建互斥、幂等、配额、TTL 回收、续期、删除锁 |
| 状态适配 | `src/store/sqliteStore.ts` | SQLite 持久化：环境全历史、状态转移、审计日志 |
| 诊断接口 | `src/server.ts` / `src/fastifyApp.ts` | HTTP 路由与错误映射（Fastify / node:http 双适配） |
| 错误契约 | `src/errors.ts` | 分类错误类型（见下） |
| 配置层 | `src/config.ts` + `config/service.config.json` | 配额、部署时长、DB 路径、端口；环境变量可覆盖 |
| 夹具 | `fixtures/template.json` | 合成环境模板（4 服务、4 个类型化参数） |
| 时钟 | `src/clock.ts` | `Clock` 接口；`VirtualClock` 注入推进时间 |

## 实例化语义

- 创建请求携带 `branch`、`owner`、`overrides`、`ttlSeconds`，与模板默认值合并为有效配置。
- 覆盖值按模板声明类型（string/number/boolean）校验；**未知参数与类型不符均拒绝并在 message/details 中指明具体键**。
- 环境分配全局唯一短标识 `env-<8 hex>`。
- 同一分支同时只能有一个活跃（deploying/active）环境：
  - 同分支同参数重复创建 → 幂等，HTTP 200 返回现有环境标识；
  - 同分支不同参数 → HTTP 409 `BRANCH_ENV_EXISTS`，`details.existingEnvId` 附现有环境标识。
- 每用户活跃环境配额（默认 2）：超出 → HTTP 429 `QUOTA_EXCEEDED`，`details.activeEnvIds` 列出当前占用。
- 时间由注入的 `VirtualClock` 推进（HTTP 模式用 `POST /admin/tick {advanceSeconds}`）：到期自动回收（状态 `reclaimed`，释放配额）；回收前可**续期一次**（`POST /environments/:id/renew`），第二次续期 409 `ALREADY_RENEWED`。
- 部署进行中（`deploying`）不允许普通删除 → 409 `DEPLOY_IN_PROGRESS`；`DELETE /environments/:id?force=true` 携带 `reason` 可强制删除，并在审计日志记录 `force_delete`（含原因、操作者、删除时状态）。
- SQLite 保存环境全历史与状态转移（`transitions` 表），支持按分支或状态查询。

## 错误语义

错误响应统一为 `{ "error": { code, category, message, details } }`，category 区分失败类别：

| category | HTTP | 含义 | 典型 code |
|---|---|---|---|
| `validation` | 400 | 输入错误（未知参数、类型不符、TTL 越界、缺 reason） | `PARAM_VALIDATION` |
| `conflict` | 409 | 状态冲突（分支占用、部署中删除、重复续期、重复删除） | `BRANCH_ENV_EXISTS`, `DEPLOY_IN_PROGRESS`, `ALREADY_RENEWED`, `ENV_ALREADY_TERMINATED` |
| `quota_exceeded` | 429 | 资源耗尽（配额占满，details 含当前占用列表） | `QUOTA_EXCEEDED` |
| `not_found` | 404 | 环境不存在 | `ENV_NOT_FOUND` |
| `internal` | 500 | 计算/未知故障，绝不吞成成功 | `INTERNAL` |

## HTTP 接口

- `POST /environments` `{branch, owner, overrides?, ttlSeconds?}` → 201/200 `{env, idempotent}`
- `POST /environments/:id/renew` → 200 `{env}`
- `DELETE /environments/:id?force=true` `{reason?, actor?}` → 200 `{env}`
- `GET /environments?branch=&status=` / `GET /environments/:id` / `GET /environments/:id/transitions`
- `GET /audit?envId=`
- `POST /admin/tick {advanceSeconds}` → 推进虚拟时钟并执行部署完成/到期回收
- `GET /health`

### 请求样例

```bash
curl -X POST http://127.0.0.1:4173/environments -H 'content-type: application/json' \
  -d '{"branch":"feat/login","owner":"alice","overrides":{"replicas":2},"ttlSeconds":300}'
curl -X POST http://127.0.0.1:4173/admin/tick -H 'content-type: application/json' -d '{"advanceSeconds":30}'
curl -X POST http://127.0.0.1:4173/environments/env-xxxxxxxx/renew
curl "http://127.0.0.1:4173/environments?status=reclaimed"
```

## 复现步骤（从干净目录）

1. 安装 Node.js >= 22.18（验证版本 v24.14.1），无需 `npm install`（可选：`npm install` 拉取 fastify）。
2. `npm test` —— 22 个测试：幂等 vs 参数冲突区分、参数校验拒绝（指名键）、到期回收与续期、配额上限与释放、删除锁与强制删除审计、并发创建互斥、运行日志 runId。
3. `npm run accept` —— 按 S1→S6 固定顺序演练：幂等/冲突、参数校验、到期回收与续期、配额池、删除锁与强制删除审计、按分支/状态查询；逐步打印请求、响应与判定，全部通过退出 0，任一失败退出 1 并打印失败场景。
4. `npm start` + 上述 curl 样例手动验证。

## 测试与日志

- 测试断言具体结果与失败类别（如 `details.existingEnvId`、转移序列 `none→deploying→active→reclaimed`），期望值硬编码，非由被测核心生成。
- 每次内核操作分配 `runId`（`run-0001`…），结构化 JSON 日志记录关键中间状态与判断理由（如 `create.idempotent`、`create.conflict`、`delete.rejected` 及原因），可据此重放问题。
- 配置覆盖环境变量：`PREVIEW_CONFIG` / `PREVIEW_TEMPLATE` / `PREVIEW_DB` / `PREVIEW_PORT` / `PREVIEW_QUOTA`。
