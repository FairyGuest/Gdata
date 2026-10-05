# snapshot-test-service

结构化快照测试服务：将输入数据的序列化结果与已存储快照做**结构化**（非字符串级）对比，
不一致时输出逐字段差异（新增 / 删除 / 修改的字段路径与前后值），支持首次自动写入、
强制更新与忽略指定字段路径。

技术栈：TypeScript + Node.js（内置 `node:http` / `node:sqlite`，零运行时依赖）。

> 说明：设计目标栈为 Fastify + SQLite。本环境离线无法安装 Fastify，HTTP 诊断层因此落在
> `node:http` 上，但路由/错误映射全部集中在 `src/http/server.ts` 这一个适配器里，引擎与
> 契约层不依赖任何 HTTP 框架，可直接平移到 Fastify（见「架构」）。SQLite 使用 Node 内置
> `node:sqlite`（Node >= 22.5 可用；Node 24 会打印一条 ExperimentalWarning，不影响功能）。

## 环境要求与依赖清单

- Node.js >= 22.5（开发验证版本：v24.14.1）
- 运行时依赖：**无**（仅 Node 标准库）
- 开发依赖（仅类型检查需要，已固定在 package.json）：
  - typescript 5.8.3
  - @types/node 24.0.15
  - tsx 4.20.3（可选，本仓库脚本均直接用 `node` 运行 .ts，Node >= 23.6 原生支持类型擦除）

## 快速开始（从干净目录复现）

```bash
npm install        # 仅安装开发依赖；无网络时可跳过，运行不依赖 node_modules
npm start          # 启动服务，默认 127.0.0.1:8787，数据库 data/snapshots.db
```

配置：`config/default.json`（host / port / db 文件 / 各项上限），可被环境变量覆盖：
`SNAPSHOT_PORT`、`SNAPSHOT_HOST`、`SNAPSHOT_DB`、`SNAPSHOT_CONFIG`。

```bash
npm test           # 27 个独立测试（diff 引擎 / 执行内核 / HTTP 接口）
npm run typecheck  # tsc --noEmit（需要 node_modules 中的 typescript）
npm run demo       # 内存数据库演示主要流程
npm run accept     # 一键验收：启动真实服务，按固定顺序演练 10 个场景，
                   # 逐步打印请求/响应/判定；全部通过退出 0，任一失败退出 1
```

## 请求样例

```bash
# 首次调用：自动创建快照（201, status=created）
curl -X POST http://127.0.0.1:8787/snapshots/compare \
  -H 'content-type: application/json' \
  -d '{"key":"order.api","data":{"user":{"address":{"city":"北京"}},"ts":1}}'

# 字段级差异：status=failed，diff 定位到 user.address.city
curl -X POST http://127.0.0.1:8787/snapshots/compare \
  -H 'content-type: application/json' \
  -d '{"key":"order.api","data":{"user":{"address":{"city":"上海"}},"ts":1}}'

# 忽略指定字段路径（如时间戳）：status=passed
curl -X POST http://127.0.0.1:8787/snapshots/compare \
  -H 'content-type: application/json' \
  -d '{"key":"order.api","data":{"user":{"address":{"city":"北京"}},"ts":999},"ignorePaths":["ts"]}'

# 强制更新快照
curl -X POST http://127.0.0.1:8787/snapshots/update \
  -H 'content-type: application/json' \
  -d '{"key":"order.api","data":{"user":{"address":{"city":"上海"}},"ts":1}}'

# 按运行编号回放诊断记录
curl http://127.0.0.1:8787/runs/<runId>
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康检查 |
| POST | /snapshots/compare | 对比；无快照时按 `createIfMissing`（默认 true）自动创建 |
| POST | /snapshots/update | 强制更新（快照必须已存在，否则 409） |
| GET | /snapshots/:key | 读取已存快照 |
| DELETE | /snapshots/:key | 删除快照（不存在则 409） |
| GET | /runs?key= | 运行记录列表（诊断回放） |
| GET | /runs/:runId | 单条运行记录 |

`compare` 请求体：`{ key, data, ignorePaths?, createIfMissing?, updateOnMismatch? }`。
响应状态：`created` / `passed` / `failed` / `updated`，均携带 `runId`、判定理由 `reason`
与结构化 `diff`（`{path, kind: added|removed|changed, before?, after?}`，数组路径形如
`items[2]`，忽略路径支持 `*` 与 `[*]` 通配一个路径段）。

## 错误语义（失败类别可区分，绝不把异常当成功）

统一错误响应：`{ "ok": false, "runId": null, "error": { "category", "message", "detail?" } }`

| category | HTTP | 含义 | 触发示例 |
| --- | --- | --- | --- |
| INPUT_ERROR | 400 | 契约解析失败：非法 JSON、缺字段、非法 key、未知路由 | 请求体不是 JSON、缺少 `data` |
| STATE_CONFLICT | 409 | 状态冲突：强制更新/删除不存在的快照、`createIfMissing=false` 且快照不存在 | update 一个从未创建的 key |
| RESOURCE_EXHAUSTED | 413 | 资源耗尽：请求体或序列化结果超过配置上限 | body > `maxPayloadBytes` |
| COMPUTE_FAILURE | 500 | 计算失败：序列化失败、已存快照损坏、其他未预期异常 | 快照内容不是合法 JSON |

未知异常一律归入 `COMPUTE_FAILURE`（500），不会静默映射为成功。

## 诊断与日志

- 每次 compare/update/delete 生成 `runId`（UUID），随响应返回。
- 运行记录（runId、key、动作、状态、判定理由、关键中间状态如 diffCount/firstPaths）持久化
  到 SQLite `runs` 表，可通过 `GET /runs/:runId` 回放。
- 服务 stdout 输出结构化 JSON 日志（ts/level/event/runId/key/status/reason）。

## 架构（模块边界与契约）

- `src/contract/` — 契约层：请求/响应 DTO、错误类别（`errors.ts`）、入参解析校验（`validate.ts`）。
- `src/core/` — 执行内核：结构化 diff（`diff.ts`）、忽略路径匹配（`ignore.ts`）、确定性序列化
  （`serialize.ts`）、快照引擎（`engine.ts`，只依赖 `SnapshotStore` 接口，不认识 HTTP/SQL）。
- `src/store/sqlite.ts` — 状态适配层：`SnapshotStore` 的 SQLite 实现（snapshots + runs 两表）。
- `src/http/server.ts` — 诊断接口适配层：路由、body 读取与限流、错误类别到 HTTP 状态码的映射。
- `src/config.ts` / `config/default.json` — 独立配置层（文件 + 环境变量覆盖）。
- `src/main.ts` — 服务入口（组装各层）。
- `test/` — 独立测试：断言具体差异内容、状态与失败类别，期望值全部手写而非由被测实现生成。
- `scripts/accept.ts` — 一键验收；`scripts/demo.ts` — 本地演示。

## 验收结果（2026-10-04 实跑）

- `npm run typecheck`：通过（tsc 5.8.3，strict）。
- `npm test`：27/27 通过（diff/engine/api 三个文件）。
- `npm run accept`：10/10 场景通过，退出码 0（嵌套字段级差异、数组增删、首次自动创建、
  忽略字段、强制更新、INPUT_ERROR/STATE_CONFLICT/RESOURCE_EXHAUSTED 分类、runId 回放）。

修复记录：413 场景曾导致后续请求 ECONNRESET——根因是超限即响应、未排空上传流，
已在 `readBody` 中改为始终完整读取请求体后再判定，回归由 accept 场景 09→10 覆盖。