# devcontainer-registry

开发环境模板注册与供应服务。管理环境模板（镜像、特性列表、资源额度、闲置超时），
处理供应请求，并把每个环境实例按状态机推进：

```
pending -> provisioning -> ready -> suspended -> ready -> ... -> deleted (终态)
```

就绪后闲置超过模板规定的 `idleTimeoutMs` 自动挂起；挂起可恢复为就绪（恢复重新计时）；
已删除是终态，任何操作返回 `410 TERMINAL_STATE`。

## 技术栈与运行前提

- **Node.js >= 22.6**（开发使用 Node 24，直接以类型擦除方式运行 TypeScript，无需编译步骤）
- **SQLite**：使用 Node 内置 `node:sqlite`，无原生依赖
- **HTTP 层**：代码按 Fastify 风格组织（路由 + `inject` 测试）。本仓库交付环境离线，
  无法安装 `fastify` 包，因此 `src/http/fastify-lite.ts` 提供了一个 API 兼容的最小适配器
  （`get/post/delete`、`:param` 路由、`inject`、`listen`）。有网络时执行
  `npm install fastify` 并把 `src/http/server.ts` 中的 `fastify()` 换成 `import fastify from 'fastify'`
  即可切换到真实 Fastify，路由与错误契约不变。

除可选的 `fastify` 外**零第三方依赖**；所有数据均为本地合成夹具，不需要任何生产账号。

## 快速开始（从干净目录复现）

```bash
npm test        # 运行全部单元测试（20 个）
npm run accept  # 一键验收：按固定顺序演练全部场景，打印请求/响应/判定；全过退出 0
npm run demo    # 本地演示脚本（内存 SQLite + VirtualClock 走查）
npm start       # 启动真实 HTTP 服务（默认 127.0.0.1:3000，SQLite 文件 data/registry.db）
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `data/registry.db` | SQLite 路径（`:memory:` 可用） |
| `MAX_CPU` | `8` | 全局 CPU 上限 |
| `MAX_MEMORY_MB` | `16384` | 全局内存上限 (MB) |
| `FEATURE_WHITELIST` | `docker-in-docker,gh-cli,node,dotnet,python,java,rust,go` | 特性白名单（逗号分隔） |
| `MAX_CONCURRENT_PROVISIONS` | `2` | 全局并发供应上限，超出排队 FIFO |
| `PROVISION_DURATION_MS` | `5000` | 模拟供应耗时 |

## API 与请求样例

```bash
# 注册模板
curl -X POST localhost:3000/templates -H 'content-type: application/json' -d '{
  "name": "node-dev", "image": "registry.local/node:20",
  "features": ["node", "docker-in-docker"],
  "cpu": 4, "memoryMb": 8192, "idleTimeoutMs": 300000
}'

# 供应环境（overrides 只能向下调资源额度）
curl -X POST localhost:3000/templates/node-dev/provisions -H 'content-type: application/json' -d '{
  "envName": "alice", "templateName": "node-dev", "overrides": { "cpu": 2 }
}'

# 查询 / 历史 / 生命周期操作
curl 'localhost:3000/environments?state=ready&template=node-dev'
curl  localhost:3000/environments/alice/history
curl -X POST localhost:3000/environments/alice/resume
curl -X POST localhost:3000/environments/alice/suspend
curl -X DELETE localhost:3000/environments/alice
curl  localhost:3000/diagnostics
```

- `POST /templates/:name/provisions`：有并发空位时 `201`（直接进入 provisioning）；
  达到全局并发上限时 `202` 并入队（返回 `queuePosition`，FIFO 消化）。
- 每次状态转移记录运行编号（`run_id`，每实例单调递增）、原因与时间点，
  持久化在 SQLite `transitions` 表，可按实例查询完整历史。

## 错误语义

所有错误响应形如 `{ "error": { "category", "message", "detail" } }`，类别可区分：

| category | HTTP | 含义 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 输入非法（空镜像名、非白名单特性、非正额度等），`detail` 指明字段 |
| `UNKNOWN_PARAMETER` | 400 | 覆盖参数含未知键，`detail` 指明该键 |
| `LIMIT_EXCEEDED` | 400 | 额度超上限（模板超全局上限 / 覆盖超模板上限），`detail` 指明字段 |
| `CONFLICT_ACTIVE_INSTANCE` | 409 | 同名环境仍有活跃实例 |
| `STATE_CONFLICT` | 409 | 当前状态不允许该操作（如 ready 时 resume） |
| `TERMINAL_STATE` | 410 | 实例已删除（终态），任何操作拒绝 |
| `NOT_FOUND` | 404 | 模板 / 环境不存在 |
| `RESOURCE_EXHAUSTED` | 503 | 资源耗尽（保留类别） |
| `INTERNAL` | 500 | 未预期错误 |

异常或未知状态绝不会被统一返回成功。

## 工程结构

```
src/
  config.ts              配置层（环境变量 -> ServiceConfig）
  clock.ts               VirtualClock（注入式时间）/ SystemClock
  errors.ts              错误契约（类别 + HTTP 状态 + detail）
  contracts/template.ts  模板契约解析与校验
  contracts/provision.ts 供应请求与覆盖参数契约
  core/registry.ts       模板注册中心
  core/provisioner.ts    执行内核：状态机、FIFO 队列、闲置扫描
  state/db.ts            SQLite schema（node:sqlite）
  state/store.ts         状态适配：模板/实例/转移历史持久化
  http/fastify-lite.ts   Fastify 兼容 HTTP 适配器（离线回退）
  http/server.ts         路由与诊断接口
  index.ts               服务入口
test/                    独立测试（node:test，断言具体结果与失败类别）
scripts/demo.ts          本地演示
scripts/accept.ts        一键验收（npm run accept）
```

## 测试与验收

- `npm test`：20 个用例，覆盖非法模板拒绝、完整生命周期、闲置超时与恢复重计时、
  同名并发恰一个成功、并发上限与 FIFO 队列。期望的转移序列（运行编号/原因/时间点）
  在测试中手写硬编码，并非由被测内核生成。
- `npm run accept`：27 项检查按固定顺序执行，逐步打印请求、响应与判定；
  全部通过退出 0，任一失败退出 1 并打印失败场景名。

最近一次本地执行结果（2026-10-06，Node v24.14.1，Windows）：

```
npm test        -> 20 pass / 0 fail
npm run accept  -> ACCEPTANCE: ALL 27 CHECKS PASSED (exit 0)
```
