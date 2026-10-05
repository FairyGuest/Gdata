# snapshot-test-service

结构化快照测试服务：将输入数据的序列化结果与已存储的快照做**结构化对比**（非字符串级），
不一致时输出逐字段差异（新增 / 删除 / 修改的字段路径与前后值），支持首次自动写入与强制更新。

## 技术栈与运行前提

- Node.js >= 22.6（开发验证使用 v24.14.1，直接以类型擦除方式运行 TypeScript，无需编译步骤）
- TypeScript 5.8.3（仅类型检查用，`npm run typecheck`）
- Fastify 5（声明为依赖；**离线环境未安装时自动回退到 `node:http` 适配器**，路由与错误语义完全一致）
- SQLite：使用 Node 内置 `node:sqlite`（实验性，零原生依赖）

## 依赖清单

| 包 | 版本 | 用途 |
|---|---|---|
| fastify | ^5.0.0 | HTTP 适配器（可选，缺失时回退 node:http） |
| typescript | 5.8.3 | 开发依赖，类型检查 |
| @types/node | 24.0.15 | 开发依赖 |

正常环境：`npm install`。本离线环境：`powershell scripts/materialize-offline-deps.ps1`
（从本机 pnpm 存储物化开发依赖；运行服务与测试本身**零依赖**，不装也能跑）。

## 快速开始

```bash
npm start          # 启动服务，默认 127.0.0.1:4319（config/default.json）
npm run demo       # 内存库演示：创建→通过→差异→忽略→强制更新
npm test           # 独立测试（22 个断言，含具体差异与错误类别）
npm run accept     # 一键验收：10 个场景固定顺序演练，全过退出 0，否则非 0
npm run typecheck  # tsc --noEmit
```

## HTTP 接口

- `POST /snapshots/compare`  主体 `{ "name": string, "data": any, "ignorePaths"?: string[], "update"?: boolean }`
  - 无快照 → 自动创建，`status: "created"`
  - 一致 → `status: "passed"`
  - 不一致 → `status: "failed"`，`diffs` 给出逐字段差异（HTTP 仍为 200，这是正常评估结果）
  - `update: true` → 强制覆盖，`status: "updated"`
- `POST /snapshots/create`  显式创建；已存在 → 409 `STATE_CONFLICT/SNAPSHOT_EXISTS`
- `GET  /snapshots/:name`   读取快照；不存在 → 409 `SNAPSHOT_NOT_FOUND`
- `GET  /health`

### 请求样例

```bash
curl -X POST http://127.0.0.1:4319/snapshots/compare \
  -H "content-type: application/json" \
  -d '{"name":"case-1","data":{"user":{"address":{"city":"Beijing"}},"tags":["a","b"]},"ignorePaths":["meta.ts"]}'
```

差异响应（`status: "failed"`）：

```json
{
  "runId": "…", "name": "case-1", "status": "failed",
  "diffs": [
    { "path": "user.address.city", "type": "modified", "before": "Beijing", "after": "Shanghai" },
    { "path": "tags[2]", "type": "added", "after": "c" }
  ],
  "ignoredPaths": ["meta.ts"],
  "reason": "2 field-level difference(s) detected"
}
```

## 差异语义

- 对象：按键递归；缺失键报 `added`/`removed`，值不同报 `modified`。
- 数组：按下标逐元素对比；长度差在对应下标报 `added`/`removed`（如 `tags[2]`）。
- 路径语法：对象键用 `.` 连接，数组下标用 `[i]`；忽略路径支持 `a.b[0].c` 与 `a.b.0.c` 两种写法。
- 忽略路径作用于该路径及其整个子树（忽略 `meta` 同时忽略 `meta.ts`）。

## 错误语义（可区分的失败类别）

所有错误响应形如 `{ "runId", "error": { "category", "code", "message" } }`，绝不把异常统一返回成功：

| category | HTTP | 含义 | 典型 code |
|---|---|---|---|
| `INPUT_ERROR` | 400 | 请求契约不合法 | `INVALID_JSON` `INVALID_BODY` `INVALID_NAME` `MISSING_DATA` `INVALID_DATA` `INVALID_IGNORE_PATHS` `INVALID_UPDATE_FLAG` `NOT_FOUND` |
| `STATE_CONFLICT` | 409 | 与已存状态冲突 | `SNAPSHOT_EXISTS` `SNAPSHOT_NOT_FOUND` |
| `RESOURCE_EXHAUSTED` | 507 | 资源耗尽 | `PAYLOAD_TOO_LARGE` `SNAPSHOT_LIMIT` |
| `COMPUTE_FAILURE` | 500 | 内部计算/存储失败 | `DIFF_FAILED` `STORE_*` `SERIALIZE_FAILED` `INTERNAL` |

## 日志与问题重放

每个请求分配 `runId`，以 JSON 行输出到 stdout 与 `logs/service.log`（`config/default.json` 的 `logFile`），
记录阶段（validate/load/diff/decision）、关键中间状态（快照是否存在、diff 数量、忽略路径）与判定理由，
可按 `runId` 过滤重放任意一次运行。

## 架构（模块边界）

```
src/
  contract/    types.ts（数据与错误契约） validate.ts（契约解析，仅抛 INPUT_ERROR）
  core/        diff.ts（纯函数结构化 diff） engine.ts（执行内核：load→diff→decide→persist）
  store/       store.ts（状态适配接口） sqliteStore.ts（SQLite 适配，序列化边界）
  diagnostics/ errors.ts（错误分类） logger.ts（runId 结构化日志）
  server/      router.ts（框架无关路由） httpAdapter.ts / fastifyAdapter.ts / app.ts（组合根） / index.ts（入口）
  config/      config.ts（default.json ← CONFIG_PATH ← 环境变量）
test/          diff/engine/api 三层独立测试（参考答案为手写期望值，非被测实现生成）
scripts/       demo.ts / accept.ts / runAllTests.ts / materialize-offline-deps.ps1
```

## 配置

`config/default.json`：`port` `host` `dbPath` `maxPayloadBytes`(默认 1MB) `maxSnapshots`(默认 10000) `logFile`。
环境变量覆盖：`PORT` `HOST` `DB_PATH` `MAX_PAYLOAD_BYTES` `MAX_SNAPSHOTS` `LOG_FILE` `CONFIG_PATH`。

## 复现步骤（干净目录验收）

1. 安装 Node >= 22.6（验证版本 v24.14.1）。
2. （可选）`npm install`；离线环境跳过即可运行，或执行 `scripts/materialize-offline-deps.ps1` 获得类型检查能力。
3. `npm test` → 22 个测试全部通过（嵌套差异定位、数组增删、首次创建、忽略字段、错误类别）。
4. `npm run accept` → 10 个场景逐步打印请求/响应/判定，输出 `acceptance OK`，退出码 0。
5. `npm start` 后用上面的 curl 样例手动验证。

## 已知说明

- 本仓库在离线沙箱中开发，fastify 未能安装，运行时使用 `node:http` 适配器（启动日志会打印实际适配器）；
  `npm install fastify` 后同一入口自动切换为 Fastify 适配器。
- `node:sqlite` 为实验性 API，启动时有 ExperimentalWarning，属预期。
- 沙箱禁止派生子进程，故 `npm test` 使用进程内 runner（`scripts/runAllTests.ts`）而非 `node --test test/`。

