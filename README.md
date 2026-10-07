# build-watcher

文件变更驱动的增量构建编排服务。输入构建目标定义（名称、监听路径集合、依赖）与文件变更事件流，计算每次需要重建的目标集合与顺序，并用内容指纹跳过未受影响的部分。所有数据均为本地合成夹具，无生产账号与真实业务数据。

## 技术栈与运行时

- Node.js >= 22.6（利用原生 TypeScript 类型擦除直接运行 `.ts`，无需编译步骤；开发验证版本 v24.14.1）
- TypeScript 5（仅用于 `npm run typecheck`，不参与运行）
- Fastify 5（诊断 HTTP 接口）
- SQLite（Node 内置 `node:sqlite`，零原生依赖）

依赖清单见 `package.json` 与 `package-lock.json`：运行时仅 `fastify`，开发依赖 `typescript`。
`src/types/node-shims.d.ts` 是离线环境下 `@types/node` 的最小替代（联网环境可 `npm i -D @types/node` 替换）。

## 目录结构

- `src/domain/` — 数据契约（`types.ts`）与错误契约（`errors.ts`）
- `src/core/graph.ts` — 契约解析后的依赖图：路径匹配 → 传递闭包 → 拓扑排序（同层字典序稳定）
- `src/core/fingerprint.ts` — 内容指纹：监听文件 sha256 的聚合哈希
- `src/core/scheduler.ts` — 执行内核：状态机、队列、构建中合并、失败阻断
- `src/store/sqliteStore.ts` — 状态适配层：目标、指纹、运行与构建历史持久化
- `src/service/buildService.ts` — 服务门面：输入校验、错误分类、查询
- `src/http/app.ts` — 诊断接口（Fastify 路由 + 错误映射）
- `src/config.ts` — 配置层（环境变量 + 默认值 + 覆盖）
- `src/fixtures/runner.ts` — 合成构建执行器（夹具）：文件含 `TRIGGER_BUILD_FAILURE` 即失败
- `src/server.ts` — 可运行服务入口
- `test/` — 独立测试（node:test，断言具体结果与失败类别）
- `scripts/demo.ts` — 本地演示；`scripts/accept.ts` — 一键验收

## 快速开始（从干净目录复现）

```bash
npm install        # 安装依赖（fastify + typescript）
npm test           # 运行全部独立测试并报告结果
npm run accept     # 一键验收：固定顺序演练全部场景，全过退出 0，否则非 0
npm run demo       # 本地演示：注册夹具目标并回放一次变更
npm start          # 启动服务（默认 127.0.0.1:8787）
npm run typecheck  # tsc --noEmit
```

配置（环境变量）：`BW_PORT`、`BW_HOST`、`BW_DB_PATH`（默认 `:memory:`）、`BW_WORKSPACE`（监听路径根目录）、`BW_BUILD_DELAY_MS`（夹具构建延迟）、`BW_MAX_REBUILD_SET`、`BW_MAX_TARGETS`。

## HTTP 接口与请求样例

```bash
# 注册目标图（仅可注册一次，重复注册返回 409 STATE_CONFLICT）
curl -X POST localhost:8787/targets -H 'content-type: application/json' -d '{
  "targets": [
    {"name":"lib","paths":["src/lib.ts"],"deps":[]},
    {"name":"app","paths":["src/app.ts"],"deps":["lib"]}
  ]}'

# 提交文件变更事件 -> 返回 runId、直接命中、传递闭包、拓扑顺序
curl -X POST localhost:8787/events -H 'content-type: application/json' -d '{"paths":["src/lib.ts"]}'

curl localhost:8787/runs/1         # 某次运行的完整记录（含每个目标的结果与理由）
curl localhost:8787/runs/1/wait    # 阻塞等待该运行完成
curl localhost:8787/targets/lib    # 最近结果、跳过记录、完整历史（来自 SQLite）
curl localhost:8787/state          # 全部目标状态机快照
```

## 判定语义

1. **变更判定两步走**：先按监听路径精确匹配得到直接受影响目标，再沿依赖边向下游取传递闭包，得到完整重建集合。
2. **构建顺序**：集合内 Kahn 拓扑排序，同层按目标名字典序，结果稳定可复现。
3. **指纹跳过**：目标指纹 = 其监听文件内容 sha256 的有序聚合哈希。事件到达但指纹与上次成功构建一致时，标记 `skipped` 并记录理由（`fingerprint unchanged (...)`），不进入执行器。
4. **状态机**：`queued → building → success | failed`。目标失败时，其下游一律标记 `blocked`，理由指明失败上游（`blocked: upstream <name> did not succeed`），不继续排队、不进入执行器。
5. **构建中合并**：目标处于 building/queued 时再次受影响，不重复排队，登记 `pendingRebuild`（记录 `merged: already building/queued, deferred to next round`），当前构建结束后折入下一轮（含其下游闭包）。
6. **运行编号**：每次事件提交分配递增 `runId`，运行计划与每条构建记录（结果、理由、指纹、起止时间）落库，可据此重放问题。

## 错误语义

错误契约：`{ "error": { "code", "message", "details" } }`，异常或未知状态绝不统一返回成功。

| code | HTTP | 含义 | 示例 |
|---|---|---|---|
| `INPUT_ERROR` | 400 | 请求契约非法 | 空 paths、路径含 `..`、依赖未知目标、重复目标名 |
| `NOT_FOUND` | 404 | 查询对象不存在 | 未知 runId、未知目标名 |
| `STATE_CONFLICT` | 409 | 与当前状态冲突 | 未注册先提交事件、重复注册目标图 |
| `RESOURCE_EXHAUSTED` | 507 | 资源上限 | 重建集合超过 `BW_MAX_REBUILD_SET`、目标数超过 `BW_MAX_TARGETS` |
| `COMPUTATION_ERROR` | 500 | 计算失败 | 依赖环、未捕获的内部异常 |

## 验证过程（保留的判定正确性证据）

- `test/graph.test.ts` — 传递闭包与拓扑顺序：断言具体集合与顺序（期望值手写，非由被测实现生成）。
- `test/scheduler.test.ts` — 指纹未变跳过（含跳过理由与执行器未再触发）、上游失败阻断下游（断言 `blocked` 及上游名）、构建期间重复变更合并为一次待重建（断言真实构建次数恰为 2）、资源耗尽/输入/状态冲突错误类别。
- `test/api.test.ts` — HTTP 层端到端与错误码映射。
- `npm run accept` — 按固定顺序演练：注册 → 闭包+拓扑 → 指纹跳过 → 失败阻断 → 构建中合并 → 错误分类，逐步打印请求、响应与判定，全部通过退出 0，任一失败非 0 并指出失败场景。

## 最近一次本地执行结果

- `npm test`：12 个测试全部通过（pass 12 / fail 0）。
- `npm run accept`：全部场景 PASS，退出码 0。
- `npm run typecheck`：通过，无错误。