# RBAC 权限判定服务

基于 TypeScript + Node.js + Fastify + SQLite（`node:sqlite`）的 RBAC 权限判定服务。

## 特性

- **多层角色继承**：子角色自动获得全部祖先角色的权限；支持菱形继承，公共祖先权限通过 visited 集合去重，不会重复计算；继承环在写入时拒绝（`STATE_CONFLICT`）。
- **通配符规则**：`*` 匹配单个路径段，`**` 匹配任意剩余段。如 `docs/*` 覆盖 `docs/read`，但不覆盖 `docs/a/b`（需 `docs/**`）。
- **deny 优先**：同一资源同一操作同时命中 allow 与 deny 时，deny 胜出。
- **默认拒绝**：未命中任何规则的请求一律拒绝。
- **策略热更新**：运行中可增删角色与策略，写入提交后查询立即生效。
- **一致性快照**：每次判定在单个 SQLite 事务内读取完整快照（带单调递增版本号），并发查询只会看到更新前或更新后的完整状态，不会看到中间态。所有变更在 `BEGIN IMMEDIATE` 事务中原子提交。
- **诊断接口**：每次判定记录运行编号（runId）、命中规则、判定理由、快照版本，可通过 `/diagnostics/decisions` 回放。

## 依赖与版本

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22.5（开发使用 v24.14.1） | 运行时，内置 `node:sqlite` 与 TypeScript 类型擦除 |
| fastify | 5.12.5 | HTTP 服务 |
| typescript | 5.9.3（dev） | 类型检查（`npm run typecheck`） |
| @types/node | 22.20.5（dev） | 类型定义 |

无原生编译依赖，无生产账号与外部服务；全部数据为本地合成夹具。

## 快速开始（干净目录复现）

```bash
npm install        # 安装上述依赖
npm test           # 运行单元 + API 集成测试（node:test，进程内执行）
npm run accept     # 一键验收：按固定顺序演练全部场景，全部通过退出 0
npm run demo       # 本地演示：菱形继承 + deny 覆盖 + 默认拒绝
npm start          # 启动服务（默认 127.0.0.1:3000，数据文件 rbac.db）
npm run typecheck  # tsc --noEmit
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RBAC_PORT` / `RBAC_HOST` | `3000` / `127.0.0.1` | 监听地址 |
| `RBAC_DB_PATH` | `rbac.db` | SQLite 路径，`:memory:` 为内存库 |
| `RBAC_MAX_ROLES` / `RBAC_MAX_POLICIES` | `1000` / `5000` | 资源上限，超限报 `RESOURCE_EXHAUSTED` |
| `RBAC_MAX_DEPTH` | `32` | 继承最大深度 |
| `RBAC_DECISION_LOG_CAPACITY` | `200` | 诊断日志环形缓冲容量 |

## API 与请求样例

```bash
# 角色（菱形：base <- left/right <- grand）
curl -X PUT localhost:3000/roles/base   -H 'content-type: application/json' -d '{"inherits":[]}'
curl -X PUT localhost:3000/roles/left   -H 'content-type: application/json' -d '{"inherits":["base"]}'
curl -X PUT localhost:3000/roles/right  -H 'content-type: application/json' -d '{"inherits":["base"]}'
curl -X PUT localhost:3000/roles/grand  -H 'content-type: application/json' -d '{"inherits":["left","right"]}'

# 策略
curl -X PUT localhost:3000/policies/p1 -H 'content-type: application/json' \
  -d '{"role":"base","resource":"docs/*","action":"read","effect":"allow"}'
curl -X PUT localhost:3000/policies/p2 -H 'content-type: application/json' \
  -d '{"role":"right","resource":"docs/secret","action":"read","effect":"deny"}'

# 判定
curl -X POST localhost:3000/check -H 'content-type: application/json' \
  -d '{"subject":{"roles":["grand"]},"resource":"docs/secret","action":"read"}'
# => {"allowed":false,"reasons":["deny overrides allow: p2"], ...}

# 诊断回放 / 健康检查
curl localhost:3000/diagnostics/decisions?limit=50
curl localhost:3000/health
```

其余端点：`GET /roles`、`GET /policies`、`DELETE /roles/:name`、`DELETE /policies/:id`。

## 错误语义

所有错误返回 `{ "error": { "category", "message", "detail" } }`，类别可区分且不会把异常统一包装成成功：

| category | HTTP | 含义 | 示例 |
| --- | --- | --- | --- |
| `INPUT_ERROR` | 400 | 请求体契约校验失败 | 字段缺失、非法字符、check 请求带通配符 |
| `STATE_CONFLICT` | 409 | 与当前状态冲突 | 引用不存在的角色、继承成环、删除仍被引用的角色 |
| `RESOURCE_EXHAUSTED` | 503 | 资源上限 | 角色/策略数量超限 |
| `INTERNAL_ERROR` | 500 | 未预期的计算/存储失败 | 判定内核抛出非契约异常 |

判定结果本身不是错误：`allowed=false` 总是 HTTP 200，`reasons` 说明理由（`default deny: no rule matched` / `deny overrides allow: ...` / `allowed by: ...`）。

## 工程结构

```
src/
  config.ts            配置层（环境变量 -> AppConfig）
  contract/            契约层：类型、错误分类、请求校验
  core/                执行内核：glob 匹配、继承闭包（去重/环检测）、decide 纯函数
  state/store.ts       状态适配：node:sqlite，事务快照 + 原子变更 + 版本号
  diagnostics/         诊断：判定日志（runId/理由/快照版本）
  server.ts            Fastify 路由装配（buildApp）
  index.ts             服务入口
test/                  node:test 测试（引擎单测 + API 集成，断言具体结果与失败类别）
scripts/accept.ts      一键验收（npm run accept）
scripts/demo.ts        本地演示
```

## 验收场景（npm run accept，固定顺序）

1. 菱形继承：`grand` 经 `left`/`right` 两条路径继承 `base`，`base` 权限只计一次
2. 分支权限：仅 `left` 的写权限对 `grand` 生效
3. 通配符：`docs/*` 覆盖单段、不覆盖嵌套段
4. deny 覆盖 allow：`docs/secret` 的 deny 胜过 `docs/*` 的 allow
5. 默认拒绝：无规则命中即拒绝
6. 热更新：新增 allow 立即生效且快照版本递增；删除规则立即恢复拒绝
7. 错误类别：`INPUT_ERROR`（400）与 `STATE_CONFLICT`（409）可区分
8. 诊断回放：每条判定带 runId 与理由

全部通过打印 `ACCEPT OK` 并退出 0；任一步失败打印 `[FAIL]` 及上下文并以非 0 退出。

## 最近一次验证结果（2026-10-02，Node v24.14.1）

- `npm test`：10/10 通过（引擎 7 项 + API 3 项）
- `npm run accept`：12/12 步通过，退出码 0
- `npm run typecheck`：无错误

