# test-report-aggregator

测试报告聚合服务：接收多个测试运行的用例结果（通过/失败/跳过 + 耗时），合并为结构化报告，支持过滤、排序，并能对任意两份历史报告做差异对比（新增失败 / 持续失败 / 恢复 / 通过）。

## 技术栈与依赖

- Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`，开发环境为 Node 24.14）
- TypeScript 5.9.3（devDependency）
- Fastify 5.12.5（唯一运行时依赖）
- @types/node 24.19.0（devDependency）
- SQLite：Node 内置 `node:sqlite`（DatabaseSync），无需外部数据库

## 快速开始（干净目录复现）

```bash
npm install        # 安装上述依赖（lockfile 固定版本）
npm run accept     # 一键验收：构建 + 单元测试 + 全场景演练，全过退出 0
npm start          # 启动服务，默认 127.0.0.1:4570
npm run demo       # 本地演示：内存库摄入两份报告并打印 diff
npm test           # 仅构建 + 单元测试
```

`npm run accept` 按固定顺序演练：健康检查 → 纯通过聚合 → 纯失败聚合 → 混合状态聚合 → 过滤/排序 → 两次报告间状态变化检测（新增失败/持续失败/恢复/通过及排序）→ 错误语义区分（400/404/409）→ 诊断日志 → 无变化 diff。每步打印请求、响应与 PASS/FAIL 判定；任一步失败以非 0 退出并指出失败场景。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 4570 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `DB_PATH` | data/reports.db | SQLite 文件路径（`:memory:` 为内存库） |
| `MAX_RUNS` | 100 | 历史报告保留上限（超出淘汰最旧） |
| `MAX_CASES_PER_RUN` | 10000 | 单个运行用例数上限 |
| `MAX_TOTAL_CASES` | 50000 | 单次摄入总用例数上限 |
| `LOG_BUFFER_SIZE` | 500 | 诊断日志环形缓冲容量 |
| `LOG_STDOUT` | true | 是否同时输出日志到 stdout |

## API

### POST /reports
摄入一个或多个测试运行，合并为一份报告。

```json
{
  "label": "nightly-2",
  "runs": [
    { "runId": "run-2", "cases": [
      { "file": "auth.test.ts", "name": "logs in", "status": "passed", "durationMs": 42 }
    ] }
  ]
}
```

- `status` 接受别名：pass/ok/success、fail/failure/error、skip/pending/ignored（大小写不敏感）。
- 同一用例（`file::name`）被多个运行覆盖且状态一致时去重保留最新；状态不一致返回 409。
- 响应 201：`{ id, createdAt, summary }`，summary 含 total/passed/failed/skipped/totalDurationMs。

### GET /reports
列出历史报告（id、label、createdAt、summary），新的在前。

### GET /reports/:id
获取报告详情，支持过滤与排序查询参数：

- `status=passed|failed|skipped` 精确过滤
- `file=<子串>`、`name=<子串>` 大小写不敏感子串过滤
- `sort=file|name|status|durationMs`，`order=asc|desc`

例：`GET /reports/3?status=failed&sort=durationMs&order=desc`

### GET /reports/:id/diff?base=<baseId>
对比 head（:id）与 base 两份报告。分类规则：

- 上次失败本次通过 → `recovered`（恢复）
- 上次非失败本次失败 → `new_failure`（新失败）
- 两次都失败 → `persistent_failure`（持续失败）
- 其余通过 → `passed`；本次跳过 → `skipped`；本次消失 → `removed`

`entries` 按 `new_failure > persistent_failure > recovered > passed > skipped > removed` 排序，`counts` 给出各类数量。

### GET /diag/logs?limit=N
返回环形缓冲中的最近日志（时间戳、级别、消息、上下文），含摄入的报告编号、用例统计与被拒绝请求的告警原因，可用于重放问题。

### GET /health
`{ "status": "ok" }`

## 错误语义

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，异常与未知状态不会返回成功：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_PAYLOAD` | 请求体结构非法（非对象、durationMs 非法等） |
| 400 | `MISSING_FIELD` | 缺少必填字段（runId、cases、file、name 等） |
| 400 | `UNKNOWN_STATUS` | 无法识别的用例状态 |
| 400 | `INVALID_QUERY` | 查询参数非法（id 非正整数、缺少 base、sort/order 非法） |
| 404 | `REPORT_NOT_FOUND` | 引用的报告不存在 |
| 409 | `STATUS_CONFLICT` | 同一摄入中多个运行对同一用例状态不一致 |
| 413 | `PAYLOAD_TOO_LARGE` | 超过用例数/请求体上限（资源耗尽） |
| 500 | `DB_FAILURE` | SQLite 打开/读写失败（计算/持久化失败） |
| 500 | `INTERNAL_ERROR` | 未预期内部错误 |

## 目录结构

```
src/
  contract/types.ts    数据契约：原始摄入、规范化用例、报告、diff 类型
  adapter/ingest.ts    状态适配：请求体验证、状态别名归一化
  kernel/aggregate.ts  执行内核：去重合并、冲突检测、限额、汇总
  kernel/query.ts      执行内核：过滤与排序
  kernel/diff.ts       执行内核：报告间状态迁移分类与排序
  store/reportStore.ts SQLite 持久化（事务写入、保留上限）
  http/server.ts       Fastify 路由与错误映射
  diag/logger.ts       环形缓冲诊断日志
  config.ts            环境变量配置层
  index.ts             服务入口
test/                  node:test 单元与 API 测试（断言具体结果与失败类别）
scripts/accept.mjs     一键验收演练（npm run accept）
scripts/demo.mjs       本地演示（npm run demo）
```

## 验证记录

在本仓库执行 `npm run accept`：13 个单元/API 测试全部通过（纯通过、纯失败、混合状态、状态冲突、限额、状态别名、diff 分类与排序、过滤排序、错误映射），随后 8 个验收场景全部 PASS，进程退出码 0。
