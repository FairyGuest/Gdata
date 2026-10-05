# test-runner-service

一个测试运行器服务：按文件名模式发现测试文件，按依赖顺序或并行执行，
收集每个测试用例的 通过 / 失败 / 超时 状态，输出汇总报告，并将历史结果存入 SQLite 供查询。

## 技术栈与版本

- Node.js >= 22.6（开发验证环境：v24.14.1，原生执行 TypeScript，无需编译步骤）
- TypeScript 5.9（仅类型检查，`npm run typecheck`）
- Fastify 5（HTTP 服务）
- SQLite（Node 内置 `node:sqlite`，零原生依赖）
- worker_threads（每个测试用例一个 worker，超时可被强制终止）

## 目录结构

- `src/contract/` — 契约层：共享类型（`types.ts`）、错误分类（`errors.ts`）、测试文件发现与契约解析（`parser.ts`）
- `src/kernel/` — 执行内核：单用例 worker（`case-worker.ts`）、调度器（`runner.ts`，拓扑排序 + 并发限制 + 超时终止）
- `src/status/` — 状态适配：内核原始结果 → 公开 passed/failed/timeout 契约（`adapter.ts`）
- `src/store/` — SQLite 历史存储与查询（`db.ts`）
- `src/server/` — Fastify 诊断/执行接口（`app.ts`）
- `src/config.ts`、`config/runner.json` — 配置层（默认值 < 配置文件 < 环境变量）
- `src/index.ts` — 服务入口
- `tests/` — 独立测试（node:test，预期值硬编码，非由被测核心生成）
- `demo/` — 演示用测试文件（pass / fail / timeout / parallel / ordered 五个场景）
- `scripts/accept.ts` — 一键验收脚本

## 测试文件契约

测试文件为 ESM `.js` 文件，默认匹配模式 `**/*.test.js`：

```js
export const dependsOn = ["other.test.js"]; // 可选：本文件依赖的文件（相对路径）
export const tests = {
  "case name": async () => { /* 抛异常即失败，否则通过 */ },
};
```

同一文件内每个用例在独立 worker 中执行，互不影响；挂起的用例被终止后其余用例照常执行。

## 快速开始（从干净目录复现）

```bash
npm install        # 安装依赖（fastify / typescript / @types/node）
npm start          # 启动服务，默认 127.0.0.1:3100，数据库 data/results.db
```

请求样例：

```bash
# 触发一次运行
curl -X POST http://127.0.0.1:3100/runs \
  -H 'content-type: application/json' \
  -d '{"dir":"demo/timeout","timeoutMs":500,"parallel":4}'

# 按 runId 查询
curl http://127.0.0.1:3100/runs/<runId>

# 按文件名 / 时间范围查询历史
curl 'http://127.0.0.1:3100/runs?file=logic.test.js&from=2026-10-01T00:00:00Z'

# 诊断信息（生效配置、活跃运行数）
curl http://127.0.0.1:3100/diagnostics
```

配置项（`config/runner.json` 或环境变量 `TEST_RUNNER_PORT` / `TEST_RUNNER_HOST` / `TEST_RUNNER_DB` / `TEST_RUNNER_CONFIG`）：
`port`、`host`、`pattern`、`timeoutMs`、`parallel`、`maxParallel`、`maxConcurrentRuns`、`dbPath`。

## 结果状态语义

| 状态 | 含义 |
| --- | --- |
| `passed` | 用例在超时时间内正常返回 |
| `failed` | 用例抛出异常（含断言失败）或 worker 崩溃；`error` 字段含名称/消息/堆栈 |
| `timeout` | 用例超过 `timeoutMs`，worker 被强制终止；`durationMs` 为实际耗时 |

任何内部异常或未知状态都不会被映射为成功：未执行的用例一律记为 `failed`（InternalError）。

## 错误语义（HTTP）

| HTTP | code | 含义 | 触发示例 |
| --- | --- | --- | --- |
| 400 | `INPUT_ERROR` | 输入非法：目录不存在、测试文件未导出 `tests`、依赖环、参数非法 | `POST /runs {"dir":"nope"}` |
| 404 | `NOT_FOUND` | 查询的 runId 不存在 | `GET /runs/<bad-id>` |
| 409 | `STATE_CONFLICT` | 同一目录已有运行进行中 | 并发对同一 dir 发两次 `POST /runs` |
| 503 | `RESOURCE_EXHAUSTED` | `parallel > maxParallel` 或并发运行数超限 | `{"parallel":999}` |
| 500 | `EXECUTION_ERROR` | 运行器内部错误 | — |

## 运行日志

内核对每个用例发出结构化事件（`run-started` / `case-scheduled` / `case-running` /
`case-finished` / `case-timeout` / `case-worker-crash` / `run-finished`），
每条包含 ISO 时间戳、`runId`、`caseId` 与判断理由（如
`exceeded timeoutMs=500 (actual 511ms), worker terminated`），可据此重放任意一次运行。

## 测试与验收

```bash
npm test           # 独立单元/集成测试（parser/adapter/kernel/store），断言具体结果与失败类别
npm run typecheck  # tsc --noEmit
npm run accept     # 一键验收：启动服务，按固定顺序演练全部场景
```

`npm run accept` 依次演练：健康检查 → 全部通过 → 断言失败（含错误信息）→
超时被终止且兄弟用例不受影响 → 并行执行互不干扰 → 依赖顺序 →
历史查询（runId / 文件名）→ 错误语义（400/404/503）。
每步打印请求、响应与判定；全部通过退出 0，任一失败退出 1 并指出失败场景。

## 最近一次验收记录（2026-10-05，Node v24.14.1）

- `npm test`：13/13 通过（parser 5、adapter 5、kernel 2、store 1）
- `npm run typecheck`：通过，0 错误
- `npm run accept`：10/10 检查通过，退出码 0
  - 超时场景：挂起用例 500ms 超时被终止（实际 511ms），同文件快速用例正常通过，整轮耗时 527ms
