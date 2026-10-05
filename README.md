# test-reporter-A：测试报告聚合服务

接收多个测试运行的结果（通过/失败/跳过 + 耗时），合并为结构化报告；支持按文件名、测试名、状态、耗时过滤与排序；可与历史报告对比，标出新增失败 / 持续失败 / 恢复的测试。历史报告存 SQLite，支持任意两次报告间差异查询。

## 环境要求与依赖清单

- Node.js >= 22.6（开发验证版本：v24.14.1）
- 运行时第三方依赖：**无**（package.json dependencies 为空）

> 技术栈说明：目标栈为 TypeScript + Fastify + SQLite。本环境离线、npm  registry 不可达，
> 因此用能力等价的 Node 内置模块实现同一架构角色，接口形状保持 Fastify 风格，联网后可平滑替换：
> - HTTP 层：node:http 封装的 Fastify 风格路由（route({method,url,handler}) / reply.status().send()），见 src/http/router.ts
> - SQLite：node:sqlite（Node 内置 DatabaseSync），见 src/storage/reports.ts
> - TypeScript：Node 原生类型擦除直接运行 .ts（无需编译步骤）
> - 测试：node:test + node:assert（进程内执行，见下文）

## 快速开始（干净目录复现）

```powershell
npm test          # 15 个单元测试：聚合/对比/存储/错误语义
npm run accept    # 一键验收：13 个场景按固定顺序演练，全过退出 0
npm run demo      # 本地演示：聚合 -> 过滤 -> 排序 -> 对比全流程
npm start         # 启动服务，默认 http://127.0.0.1:8787
```

配置（环境变量）：REPORTER_PORT（默认 8787）、REPORTER_HOST、REPORTER_DB（默认 :memory:，传文件路径即持久化）、REPORTER_MAX_CASES（默认 100000）、REPORTER_MAX_RUNS（默认 1000）。

## 模块边界

- src/contracts/：数据契约（types.ts）与输入解析校验（parse.ts）
- src/adapters/status.ts：状态适配，外部状态词归一化为 passed/failed/skipped
- src/core/：执行内核——aggregate.ts（聚合+过滤排序）、compare.ts（对比分类排序）
- src/storage/reports.ts：SQLite 历史报告存取
- src/diagnostics/：错误分类（errors.ts）与结构化日志（logger.ts）
- src/http/router.ts + src/app.ts + src/server.ts：HTTP 适配、组装、入口
- src/config.ts：配置层；tests/：独立测试；scripts/：演示与验收

## API 与请求样例

- POST /api/reports —— 提交一次报告（可含多个运行）
  ```json
  {"reportId":"nightly-001","runs":[{"runId":"run-101","cases":[
    {"file":"auth.spec.ts","name":"login ok","status":"passed","durationMs":120},
    {"file":"auth.spec.ts","name":"login bad pwd","status":"failed","durationMs":98}]}]}
  ```
- GET /api/reports —— 列出历史报告
- GET /api/reports/:id?file=&name=&status=&minDurationMs=&maxDurationMs=&sortBy=file|name|status|durationMs&order=asc|desc
- GET /api/reports/:a/diff/:b —— 任意两次报告差异
- GET /api/diagnostics/errors —— 错误语义目录；GET /api/diagnostics/logs —— 结构化运行日志
- GET /health

## 对比语义

- new_failure：上次非失败（通过/跳过/不存在按 added 另计），本次失败
- persistent_failure：两次都失败
- recovered：上次失败，本次通过（失败->跳过不算恢复，归为 passed）
- passed：其余无变化；added/removed：仅一侧存在
- 排序：new_failure > persistent_failure > recovered > passed > added > removed

## 错误语义（异常绝不统一返回成功）

| code | HTTP | 含义 |
|---|---|---|
| INPUT_ERROR | 400 | 请求体结构/字段类型非法（如 durationMs 为负） |
| UNKNOWN_STATUS | 422 | 无法识别的测试状态词 |
| STATUS_CONFLICT | 409 | 同一用例在多次运行中状态冲突（同状态重复则幂等去重） |
| RESOURCE_EXHAUSTED | 413 | 超出 REPORTER_MAX_CASES / REPORTER_MAX_RUNS 上限 |
| NOT_FOUND | 404 | 报告或路由不存在 |
| COMPUTATION_FAILED | 500 | 聚合/对比计算失败 |
| STORAGE_FAILED | 500 | SQLite 读写失败 |

错误响应统一为 {"error":{"code","message","details"}}。

## 诊断与重放

日志为结构化 JSON 行，包含 ts/level/event/runId/reportId/state/reason，
可凭 runId + reportId 定位输入，凭 state（中间状态）与 reason（判断理由）重放分类决策；
GET /api/diagnostics/logs 可拉取当前进程日志缓冲。

## 验收

npm run accept 按固定顺序执行 13 个场景（健康检查、纯通过、纯失败、混合基线/目标、
过滤排序、报告对比、INPUT_ERROR、UNKNOWN_STATUS、STATUS_CONFLICT、RESOURCE_EXHAUSTED、
NOT_FOUND、诊断日志），逐步打印请求/响应/判定；全部通过退出 0，任一失败非 0 并打印失败场景名。
测试断言具体数值与失败类别（参考答案硬编码于 tests/，非由被测核心生成）。

最近一次执行结果：npm test 15/15 通过；npm run accept 13/13 通过，退出码 0。

