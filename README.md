# load-tester-B

HTTP 负载测试服务：以可配置的并发数、总请求数和请求间隔向目标 URL 发起请求，
收集每次请求的延迟、状态码与成功/失败结果，输出延迟分布统计
（P50/P90/P95/P99、最大/最小/平均值）与吞吐量（RPS），并将历史结果存入 SQLite，
支持按目标 URL 或时间范围查询对比。

## 技术栈与依赖

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 23.6（开发验证用 v24.14.1） | 直接使用内置 TypeScript 类型擦除运行 .ts，无需编译 |
| SQLite | Node 内置 `node:sqlite`（实验特性） | 无需外部数据库 |
| fastify | 5.0.0-local（`vendor/fastify`） | 离线环境下的 Fastify API 子集；有网络时可替换为上游 fastify@5 |

安装与运行均不需要联网：`npm install` 仅链接本地 vendor 包。

## 快速开始（干净目录复现）

```bash
npm install        # 链接本地依赖
npm test           # 运行全部独立测试（统计/引擎/API，共 14 个用例）
npm run accept     # 一键验收：固定顺序演练全部场景，全过退出 0，任一失败非 0
npm run demo       # 本地演示：内置目标服务器 + 一次 100 请求压测
npm start          # 启动服务（默认 127.0.0.1:3000，DB_PATH 可指定 SQLite 路径）
```

### 请求样例

```bash
curl -X POST http://127.0.0.1:3000/runs \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:8080/api","requests":100,"concurrency":10,"intervalMs":5,"timeoutMs":2000}'
```

响应（201）包含 `id`、`succeeded`/`failed`、`failuresByKind`、`statusCodes`、
`throughputRps`、`successLatency`/`failureLatency`（min/max/mean/p50/p90/p95/p99）
以及每一次请求的 `outcomes` 明细。

历史查询：

```bash
curl 'http://127.0.0.1:3000/runs?url=http://127.0.0.1:8080/api'     # 按目标 URL
curl 'http://127.0.0.1:3000/runs?from=2026-10-01T00:00:00Z&to=...'  # 按时间范围
curl http://127.0.0.1:3000/runs/1                                    # 单次运行详情
```

## 配置项（POST /runs）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | 必填 | 目标 URL，仅 http/https |
| `method` | GET | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| `requests` | 10 | 总请求数，1..100000 |
| `concurrency` | 2 | 并发 worker 数，1..1000 |
| `intervalMs` | 0 | 每个 worker 两次请求之间的间隔（毫秒） |
| `timeoutMs` | 10000 | 单请求超时 |
| `headers` / `body` | - | 可选请求头与请求体 |

## 成功 / 失败语义

- **成功**：响应状态码 2xx。
- **失败**单独分类统计，延迟与成功请求分开计算（`successLatency` vs `failureLatency`）：
  - `http_status`：收到非 2xx 响应；
  - `timeout`：客户端超时（`timeoutMs`）；
  - `connection`：连接被拒绝、DNS 失败等网络错误。
- 并发场景下每个请求的结果写入按序号预分配的槽位，内核在汇总前校验无空洞；
  若发现丢失则抛出 `COMPUTATION_FAILURE`，绝不静默吞掉结果。

## API 错误语义

错误响应统一为 `{ "error": { "code", "message" } }`，异常或未知状态**不会**被当作成功返回：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INPUT_ERROR` | 契约解析失败，message 列出全部违规项 |
| 404 | `NOT_FOUND` | 查询的运行 ID 不存在 |
| 409 | `STATE_CONFLICT` | 已有压测运行中（服务同一时间只执行一个运行） |
| 500 | `COMPUTATION_FAILURE` | 执行/统计阶段的内部计算失败（如结果丢失校验） |
| 503 | `RESOURCE_EXHAUSTED` | 预留：资源耗尽 |
| 500 | `INTERNAL` | 未分类异常兜底 |

## 日志与可重放性

每次运行输出带关键中间状态的结构化日志，可用于重放问题：
`run.start`（配置与 URL）→ `run.workers`（worker 数）→
`request.failure`（seq、失败类别、原因）→ `run.done`（总数/成功/失败/耗时/RPS）→
`run.persisted`（运行 ID）。运行 ID 即 SQLite 主键，可用 `GET /runs/:id` 取回完整结果。

## 模块结构

- `src/contracts.ts` — 模块间共享的数据与错误契约（RunConfig/RunResult/AppError）
- `src/config.ts` — 契约解析层：未受信输入 → 校验后的 RunConfig
- `src/engine.ts` — 执行内核：并发调度、间隔控制、失败分类、结果完整性校验
- `src/stats.ts` — 纯统计：nearest-rank 百分位、min/max/mean
- `src/store.ts` — 状态适配层：SQLite 持久化与按 URL/时间查询
- `src/server.ts` — 诊断接口层：Fastify 路由、错误码 → HTTP 状态映射
- `src/index.ts` — 服务入口
- `tests/` — 独立测试（统计边界值、引擎行为、API 契约）
- `scripts/accept.ts` — 一键验收；`scripts/demo.ts` — 本地演示

## 测试与验收

`npm test` 实际执行 14 个用例，断言具体数值与失败类别（非"能调用即可"）：

- 统计：n=10 / n=100 样本的 P50/P90/P95/P99 边界值、乱序与重复值、空样本；
  参考答案为手工按 nearest-rank（rank = ceil(p/100·n)）计算的字面量，不由被测实现生成。
- 引擎：低并发全部成功且不丢结果（校验 seq 0..N-1 完整）、混合成功/失败分类、
  非 2xx 归类、超时归类、连接失败归类、intervalMs 节奏。
- API：创建并持久化、按 URL/时间查询、400/404/409 错误语义。

`npm run accept` 按固定顺序演练 S1–S7（百分位边界 → 低并发全成功 → 混合失败 →
超时分类 → 输入错误 → 未知 ID → 历史查询），逐步打印请求、响应与判定；
全部通过退出 0，任一场景失败退出 1 并打印失败场景名与原因。

最近一次验证（2026-10-05，Node v24.14.1）：`npm test` 14/14 通过；
`npm run accept` S1–S7 全部 PASS，退出码 0。
