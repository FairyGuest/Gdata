# load-tester-a

HTTP 负载测试服务：以可配置的并发数、总请求数与请求间隔向目标 URL 发起请求，
收集每次请求的延迟 / 状态码 / 成功失败分类，输出延迟分布统计
（P50/P90/P99、min/max/avg）与吞吐量（RPS），并把历史结果存入 SQLite，
支持按目标 URL 与时间范围查询、两次运行对比。

## 环境与依赖

- Node.js **>= 22.6**（开发验证版本：v24.14.1）。运行时利用 Node 原生
  TypeScript 类型擦除直接执行 `.ts`，无需构建步骤。
- SQLite 使用 Node 内置 `node:sqlite`，无需原生编译。
- 声明依赖（`package.json`）：`fastify@^5.2.0`（运行时）、`typescript` /
  `@types/node`（开发）。
  **注意**：本交付环境无 npm registry 访问，无法安装 fastify，因此 HTTP 层
  通过 `src/http-adapter.ts` 抽象，默认实现基于 `node:http`，路由契约
  （method+path → handler(req, reply)）与 Fastify 形状一致。联网环境执行
  `npm install` 后，可在 adapter 接口上替换为 Fastify 实现而不改动
  `src/server.ts` 中的任何路由逻辑。除 fastify 外无其他运行时依赖，
  当前代码在零 `node_modules` 的干净目录即可运行。

## 快速开始

```bash
npm start                 # 启动服务，默认 127.0.0.1:8080，DB 为 ./loadtest.db
# 环境变量: PORT / HOST / DB_PATH
npm run demo              # 本地演示：内嵌桩目标 + 一次混合负载，打印汇总
npm test                  # 单元 + 集成测试（21 个用例）
npm run accept            # 一键验收：固定顺序演练全部场景，全过退出 0
```

### 请求样例

```bash
curl -X POST http://127.0.0.1:8080/runs \
  -H 'content-type: application/json' \
  -d '{"targetUrl":"http://127.0.0.1:9000/api","concurrency":10,"totalRequests":200,"requestIntervalMs":5,"timeoutMs":3000}'
# -> 202 {"runId":"run-...","status":"running"}

curl http://127.0.0.1:8080/runs/<runId>                 # 运行记录 + 汇总统计
curl http://127.0.0.1:8080/runs/<runId>/results         # 每次请求明细
curl 'http://127.0.0.1:8080/runs?targetUrl=...&from=...&to=...'   # 历史查询
curl http://127.0.0.1:8080/runs/<idA>/compare/<idB>     # 两次运行对比
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/diagnostics                  # 活跃运行数、近期错误
```

配置字段（`POST /runs` 请求体）：

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `targetUrl` | string | 必填 | http/https URL |
| `concurrency` | int | 1 | 1..512 |
| `totalRequests` | int | 10 | 1..1,000,000 |
| `requestIntervalMs` | int | 0 | 0..60,000（每个 worker 两次请求之间的间隔） |
| `timeoutMs` | int | 10000 | 1..120,000 |

## 统计口径

- 成功 = HTTP 2xx；失败分三类：`http_error`（非 2xx）、`timeout`
  （超过 timeoutMs）、`network_error`（连接失败等无响应错误）。
- 成功与失败延迟**分开**统计（`successStats` / `failureStats`，无样本时为 `null`）。
- 百分位方法：升序样本上的线性插值（rank = p/100 × (n−1)，与 numpy 默认一致）。
- 吞吐量 = totalRequests / 运行墙钟时长（秒）。
- 并发场景下每次请求恰好产生一条结果记录，引擎在收尾时校验
  `results.length === totalRequests`，缺漏即判运行失败，绝不静默丢结果。

## 错误语义

所有错误响应形状为 `{ "error": { "code", "message", "details?" } }`，
异常或未知状态**不会**被统一返回为成功：

| code | HTTP | 含义 | 例子 |
|---|---|---|---|
| `INPUT_ERROR` | 400 | 请求体/参数非法 | URL 非法、concurrency=0、from>to、JSON 解析失败 |
| `NOT_FOUND` | 404 | 引用的运行不存在 | GET /runs/不存在 |
| `STATE_CONFLICT` | 409 | 状态不允许该操作 | 对比尚未完成的运行 |
| `RESOURCE_EXHAUSTED` | 429 | 资源超限 | 并发运行数超过上限（默认 4） |
| `CALCULATION_FAILED` | 500 | 统计计算失败 | 空样本/非法延迟值 |
| `INTERNAL_ERROR` | 500 | 未预期错误 | — |

运行级失败会落库为 `status="failed"` 并带 `error.code/message`。

## 日志与可重放性

运行日志每行形如
`[run=<runId>] state=<accepted|request|persisted|completed|failed> reason=...`，
包含运行编号、每请求中间状态（seq、outcome、status、latency、失败类别）
与判定理由（如失败分类计数、RPS），可据此重放问题。

## 工程结构

- `src/types.ts` — 模块间数据契约（RunConfig / RequestResult / RunSummary …）
- `src/errors.ts` — 错误分类与 HTTP 映射
- `src/config.ts` — 契约解析与校验（纯函数）
- `src/stats.ts` — 百分位与分布统计（纯函数）
- `src/engine.ts` — 执行内核（worker 池并发、间隔、超时分类）
- `src/store.ts` — SQLite 持久化与查询
- `src/runner.ts` — 运行编排、并发运行上限、结构化日志
- `src/http-adapter.ts` — HTTP 框架适配层（默认 node:http，可换 Fastify）
- `src/server.ts` — 路由注册；`src/index.ts` — 服务入口
- `test/` — 桩目标服务器 + stats/config/engine/api 测试
- `scripts/demo.mjs` / `scripts/accept.mjs` — 演示与一键验收

## 复现步骤（干净目录）

```bash
node -v            # 确认 >= 22.6（验证版本 v24.14.1）
npm test           # 期望: 21 pass / 0 fail
npm run accept     # 期望: 末尾 "ACCEPTANCE PASSED"，退出码 0
npm run demo       # 可选：查看一次完整运行的日志与汇总
```

验收脚本按固定顺序演练：S1 健康/诊断 → S2 输入错误语义 → S3 未找到 →
S4 低并发全成功（含结果不丢失校验）→ S5 混合成功失败分类 →
S6 百分位边界值（桩服务器确定性 10..100ms 延迟，服务统计与脚本内
**独立参考实现**逐项比对）→ S7 timeout/network_error 分类 →
S8 历史查询与对比 → S9 并发运行数超限（429）。每步打印请求、响应与判定，
任一判定失败即以非 0 退出并指出失败场景。

## 本次交付实测结果（2026-10-03，Node v24.14.1，Windows）

- `npm test`：21 pass / 0 fail（含全成功、混合失败、超时、连接拒绝、
  间隔生效、百分位边界手工参考值等断言）。
- `npm run accept`：S1–S9 全部 PASS，退出码 0。
- `npm run demo`：40 请求混合负载，成功 20 / http_error 20，退出码 0。
