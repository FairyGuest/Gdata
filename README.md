
# incremental-build-orchestrator

文件变更驱动的增量构建编排服务。输入构建目标定义（名称、监听路径集合、依赖）与文件变更事件流，计算每次需要重建的目标集合与顺序，并用内容指纹跳过未受影响的部分。所有外部参与者（构建工具）均为本地夹具，无需生产账号。

## 技术栈与依赖

- Node.js >= 22.6（直接运行 TypeScript，类型剥离模式；实际验证于 v24.14.1）
- TypeScript 5.9.3（仅类型检查，npm run typecheck）
- Fastify 5.12.5（诊断 HTTP 接口）
- SQLite：Node 内置 node:sqlite（实验性，无原生依赖）
- 测试：Node 内置 node:test（--test-isolation=none 单进程顺序执行）

完整锁定版本见 package-lock.json。安装：npm ci（或 npm install）。

## 目录结构

- src/domain/ — 跨模块数据契约（types.ts）与错误契约（errors.ts）
- src/core/graph.ts — 契约解析/校验、传递闭包、稳定拓扑排序（纯计算，无 I/O）
- src/core/fingerprint.ts — 监听文件内容指纹（sha256 聚合）
- src/core/engine.ts — 执行内核：调度、跳过、阻断、合并
- src/adapters/ — 构建器夹具（FixtureBuilder）与诊断日志（RingLogger）
- src/store/sqlite.ts — SQLite 状态适配（指纹 + 构建历史）
- src/http/server.ts — Fastify 诊断接口，错误类别到 HTTP 状态映射
- src/config.ts / src/main.ts — 配置层与服务入口
- test/ — 单元与集成测试（断言具体结果与失败类别）
- scripts/demo.ts / scripts/accept.ts — 本地演示与一键验收
- fixtures/targets.json — 演示/验收共用的目标定义夹具
- types/node-shims.d.ts — Node API 的最小环境声明（离线环境无 @types/node）

## 快速开始（从干净目录复现）

    npm ci                # 安装依赖（fastify + typescript）
    npm test              # 19 个测试：图计算/指纹/引擎/HTTP
    npm run accept        # 一键验收：先跑全部测试，再按固定顺序演练 7 个场景
    npm run demo          # 叙事式演示（进程内，无端口）
    npm start             # 真正启动服务，默认 http://127.0.0.1:3050

npm run accept 全部通过退出 0；任一场景失败非 0 退出并打印失败场景名。测试与验收实际执行，输出包含每次请求、响应与判定理由。

## 配置（环境变量，均有本地默认值）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| PORT / HOST | 3050 / 127.0.0.1 | 监听地址 |
| DB_PATH | .data/builds.db | SQLite 文件（:memory: 可用于测试） |
| WORKSPACE_ROOT | .data/workspace | 监听路径的解析根目录 |
| BUILD_DELAY_MS | 50 | 夹具构建延迟（让构建中合并可观察） |
| MAX_QUEUE_SIZE | 1000 | 队列深度上限，超出报 resource-exhausted |
| MAX_TARGETS | 500 | 目标数量上限 |
| LOG_FILE | .data/engine.log | JSONL 诊断日志（含 runId，可重放） |

## 请求样例

    # 注册目标（lib<-app, lib<-ui, util<-app, docs 独立）
    curl -X POST localhost:3050/targets -H "content-type: application/json" -d @fixtures/targets.json

    # 提交变更事件；响应即本次运行报告（runId、affected、order、outcomes）
    curl -X POST localhost:3050/events -H "content-type: application/json" -d "{"paths":["lib.txt"]}"

    # 查询目标最近一次结果与指纹、完整历史（含跳过记录）、诊断日志
    curl localhost:3050/targets/lib
    curl localhost:3050/targets/lib/history
    curl "localhost:3050/logs?runId=run-0001"

## 判定规则

1. 变更判定：先按路径精确匹配找出直接受影响目标，再沿依赖反向边取传递闭包。
2. 构建顺序：受影响集合内拓扑排序（依赖在前），就绪集中按目标名字典序贪心取最小，输出稳定。
3. 指纹跳过：目标指纹 = 监听文件内容哈希（sha256）排序聚合；事件到达但指纹与上次成功构建一致时标记 skipped 并给出理由。
4. 失败阻断：目标构建失败时，本次运行内其所有下游标记 blocked 并指明 blockedBy，不再排队、不执行。
5. 构建中合并：构建中的目标再次受影响时不重复排队，登记为待重建，当前构建结束后恰好再构建一次；已排队目标的重复事件直接合并。

## 错误语义

所有失败都是带类别的 OrchestratorError，HTTP 层映射为不同状态码，绝不把异常统一返回成功：

| 类别 | HTTP | 含义 | 例子 |
| --- | --- | --- | --- |
| contract | 400 | 输入契约错误 | 目标定义缺字段、依赖未知目标、依赖环、事件载荷非法 |
| state-conflict | 409 | 与运行时状态冲突 | 未注册目标就提交事件、构建期间重定义目标 |
| resource-exhausted | 507 | 容量超限 | 队列深度超过 MAX_QUEUE_SIZE |
| computation | 500 | 内部计算失败 | 指纹计算失败、构建器崩溃 |
| not-found | 404 | 实体不存在 | 查询未知 runId |

目标运行时状态：idle / queued / building；单次运行内的结果：success / failed / skipped（指纹未变）/ blocked（上游失败，含 blockedBy）。

## 日志与重放

每个运行有单调递增的 runId（run-0001…）。RingLogger 同时写内存环形缓冲与 JSONL 文件，记录 run 创建时的变更路径、受影响集合、拓扑顺序，以及每个目标的排队/开始/跳过/成功/失败/阻断/合并事件与理由。按 GET /logs?runId=... 或直接检索日志文件即可重放问题现场。

## 测试与验收记录

- npm test：19 个测试全部通过（图闭包/拓扑序、指纹独立复算、跳过理由、失败阻断、构建中合并恰好一次、错误类别、SQLite 历史）。
- npm run accept：测试 19/19 通过后，S1–S7 场景全部 PASS，退出码 0（交付前实际执行验证）。
- 测试中的期望值（闭包集合、拓扑顺序、聚合哈希）均手工推导或用 node:crypto 独立复算，不由被测实现生成。

