# Mutation Testing Service

对输入源码执行预定义代码变换（变异体），逐个在隔离工作区运行测试套件，
判定变异体被“杀死”（测试失败）还是“存活”（测试通过），输出变异得分率
（killed / total，超时也计为杀死）与存活变异体列表。历史结果持久化到
SQLite，可按文件名、变异类型、状态查询。

## 技术栈与依赖清单

- Node.js >= 23.6（开发验证版本 v24.14.1），TypeScript（原生类型擦除运行，无需构建）
- 运行时依赖：**零外部 npm 包**（package.json 的 dependencies 为空）
  - HTTP 层：node:http（超薄路由，见下方“关于 Fastify”说明）
  - SQLite：node:sqlite（Node 内置，实验性）
  - 测试：node:test
- 安装：npm install（仅写入 lockfile，无实际下载）；离线环境可直接使用

### 关于 Fastify

目标栈为 TypeScript + Node.js + Fastify + SQLite。本交付环境离线
（npm registry 不可达，fastify/better-sqlite3 无法安装），因此 HTTP
层用 node:http 实现、SQLite 用 node:sqlite 实现。分层上
src/server/http.ts（诊断接口）与 src/store/sqlite.ts（状态适配）均为
可替换适配器：服务核心（src/service.ts）只依赖它们的接口，联网后将
http.ts 替换为 Fastify 路由、sqlite.ts 替换为 better-sqlite3 即可，核心
代码与契约不变。

## 目录结构（工程边界）

- src/contract/types.ts — 模块间数据契约（Mutant / MutantResult / RunRecord ...）
- src/contract/errors.ts — 错误契约（ServiceError + 稳定错误码 → HTTP 状态映射）
- src/mutator/operators.ts — 预定义变异算子（===↔!==、+↔-、*→/、边界、布尔、删调用）
- src/mutator/engine.ts — 按源码位置扫描生成变异体（跳过字符串/注释，最长匹配）
- src/mutator/apply.ts — 应用单个变异体；源码漂移报 STATE_CONFLICT
- src/runner/kernel.ts — 执行内核：复制项目到临时目录 → 应用变异 → 跑测试 → 分类 → 清理（原始代码不被触碰）
- src/store/sqlite.ts — 状态适配：SQLite 持久化 runs + mutant_results，支持 file/type/status 查询
- src/server/http.ts — 诊断 HTTP 接口
- src/service.ts — 编排：契约解析 → 生成 → 执行 → 评分 → 持久化；资源守卫与并发冲突
- src/config.ts — 配置层（环境变量覆盖）
- src/index.ts — 服务入口
- test/ — 单元 / 契约 / 集成 / API 测试（31 个）
- fixtures/ — killed / survived / sample(混合) 三个验证项目
- scripts/demo.mjs — 本地演示；scripts/accept.mjs — 一键验收

## 快速开始（干净目录复现）

    npm install          # 无外部依赖，秒完成
    npm test             # 31 个测试，全部实际执行并报告 pass/fail
    npm run accept       # 一键验收：11 个场景，全过退出 0，失败非 0 并指明场景
    npm run demo         # 对 fixtures/sample 跑一次完整变异测试并打印明细
    npm start            # 启动 HTTP 服务，默认 127.0.0.1:4737

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| MTS_HOST / MTS_PORT | 127.0.0.1 / 4737 | 监听地址 |
| MTS_DB | mutation-history.db | SQLite 路径，:memory: 可用 |
| MTS_TEST_CMD | node --test test/ | 默认测试命令（spawn 执行器） |
| MTS_TIMEOUT_MS | 20000 | 每个变异体的测试超时 |
| MTS_MAX_MUTANTS | 500 | 单次运行变异体数量上限（资源守卫） |
| MTS_EXECUTOR | spawn | spawn（子进程）或 inprocess（进程内 node:test，用于禁止 fork 的沙箱） |

注意：在禁止创建子进程的环境中，spawn 执行器会返回
EXECUTION_FAILED 并提示改用 MTS_EXECUTOR=inprocess。

### 请求样例

    # 发起一次变异测试运行
    curl -X POST http://127.0.0.1:4737/runs -H 'content-type: application/json' -d '{
      "projectDir": "fixtures/sample",
      "types": ["EqualityOperator", "ArithmeticOperator", "RemoveCall"],
      "maxMutants": 100,
      "timeoutMs": 10000
    }'
    # => 201 { runId, total, killed, survived, score, survivors[], results[] }

    curl http://127.0.0.1:4737/runs/<runId>                 # 按运行编号重放完整结果
    curl http://127.0.0.1:4737/runs                         # 历史运行列表
    curl 'http://127.0.0.1:4737/mutants?file=src/calc.js'   # 按文件名查历史变异结果
    curl 'http://127.0.0.1:4737/mutants?type=ArithmeticOperator&status=survived'
    curl http://127.0.0.1:4737/health

## 错误语义

所有跨模块失败都是 ServiceError，携带稳定机器可分辨的错误码；
未知异常映射为 INTERNAL/500，**不会**被统一吞成成功。

| 码 | HTTP | 含义 | 触发示例 |
|---|---|---|---|
| INPUT_INVALID | 400 | 请求契约非法 | 非 JSON body、缺 projectDir、目录不存在、未知变异类型、非正 timeoutMs |
| NOT_FOUND | 404 | 资源不存在 | 未知 runId、未知路由 |
| STATE_CONFLICT | 409 | 状态冲突 | 同一 projectDir 已有运行在进行；应用变异时源码漂移 |
| RESOURCE_EXHAUSTED | 429 | 资源耗尽 | 变异体数量超过 maxMutants 预算 |
| EXECUTION_FAILED | 502 | 执行失败 | 测试命令不存在、子进程创建被禁止、SQLite 打开失败 |
| INTERNAL | 500 | 未分类异常 | 任何未预期错误 |

错误响应体：{ "error": { "code", "message", "details" } }。

单个变异体级别的状态（非错误码）：killed（测试退出码非 0）、
survived（退出码 0）、timeout（超时，计入杀死）、error
（该变异体执行异常，不影响其他变异体，也不计为杀死）。

## 日志与可重放性

- 每次运行分配 runId（UUID），日志行均带 run=<runId>、
  mutant=<mutantId>、应用的替换、判定状态、退出码、耗时与判定理由。
- 每个变异体结果持久化 reason（判定理由）与 testOutputTail
  （测试输出尾部），配合 GET /runs/:id 可完整重放一次运行。

## 验证设计（参考答案非自证）

fixtures/ 下三个项目的期望结果由人工从源码推导，测试断言具体数值：

- fixtures/killed：add 的 + → - 必被断言 add(2,3)===5 杀死 → score = 1
- fixtures/survived：multiply 的 * → / 无任何测试调用 → score = 0，存活者为 *
- fixtures/sample：5 个变异体（+、*、>、删 send() 调用、true→false），
  其中 * → / 无测试覆盖而存活 → score = 0.8，存活列表恰为该变异体

集成测试（test/integration.test.ts）断言总数、杀死数、存活者身份、
得分率与失败类别（RESOURCE_EXHAUSTED / STATE_CONFLICT / EXECUTION_FAILED /
NOT_FOUND），而非仅检查接口可调。

## 验收

npm run accept 按固定顺序演练 11 个场景：健康检查 → 杀死 → 存活 →
混合(0.8) → 按 runId 重放 → 按文件/类型查历史 → INPUT_INVALID →
NOT_FOUND → STATE_CONFLICT → RESOURCE_EXHAUSTED → EXECUTION_FAILED。
每步打印请求、响应与判定；全部通过退出 0，任一失败退出 1 并打印失败场景名。

最近一次在本机（Node v24.14.1, Windows）执行结果：
npm test 31/31 通过；npm run accept 11/11 通过，退出码 0。
