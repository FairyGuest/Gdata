# Devcontainer Registry & Provisioning Service

开发环境模板注册与供应服务。管理环境模板（镜像、特性、资源额度、闲置超时），
处理供应请求，按状态机推进环境实例，就绪后闲置超时自动挂起。
全部数据使用本地合成夹具，无需任何生产账号或外部服务。

## 技术栈与运行前提

- **Node.js >= 24**（本仓库在 Node v24.14.1 上验证）
- **TypeScript**：直接以 .ts 源码运行（Node 24 原生类型擦除，无需编译步骤）
- **SQLite**：Node 内置 node:sqlite（实验性 API，Node 24 可用）
- **HTTP**：src/adapters/http.ts 是一个 Fastify 风格的最小适配器（路由注册 /
  JSON 解析 / 错误映射与 Fastify 约定一致）。**本环境离线无法安装 npm 依赖**，
  因此以零依赖方式交付；接入真实 Fastify 时只需替换该适配器，内核无需改动。
- **零 npm 依赖**：package.json 无 dependencies，克隆后即可运行。

## 一键验收

    npm run accept   # 固定顺序演练全部场景，逐步打印请求/响应/判定；全过退出 0，任一失败非 0
    npm test         # node:test 独立测试（18 个用例，断言具体结果与错误类别）
    npm run demo     # 启动 HTTP 服务并用真实 HTTP 请求走一遍主流程
    npm start        # 启动服务（默认 :3000，数据在 data/registry.db）

最近一次实测结果：accept 27 项检查全部 PASS（退出码 0），test 18/18 通过，
demo 全流程输出符合预期（含 400/409/410 错误路径）。

## 目录结构（工程边界）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 契约解析 | src/domain/template.ts, src/domain/types.ts, src/domain/errors.ts | 模板/覆盖参数校验、错误契约（错误码 + details） |
| 执行内核 | src/kernel/provisioner.ts, src/kernel/clock.ts | 状态机、FIFO 队列、并发上限、闲置挂起调度（VirtualClock 注入） |
| 状态适配 | src/store/sqlite.ts | SQLite 持久化：实例表 + 转移历史表（runId/原因/时间） |
| 诊断接口 | src/adapters/http.ts, src/server.ts | HTTP 路由、错误码→状态码映射、/diagnostics、/clock/advance |
| 配置层 | src/config.ts | 白名单、全局上限、并发/队列上限，均可环境变量覆盖 |
| 测试层 | test/*.test.ts | 模板校验、覆盖契约、生命周期、并发、持久化 |
| 验收/演示 | scripts/accept.ts, scripts/demo.ts | 一键验收与本地演示 |

## 状态机

PENDING → PROVISIONING → READY → SUSPENDED →(resume) READY … → DELETED

- 有空闲并发槽时 PENDING 立即转 PROVISIONING，否则进入 FIFO 队列。
- 供应耗时由 provisionDurationMs（虚拟时间）模拟，完成后转 READY。
- READY 起算闲置计时，超过模板 idleTimeoutMs 自动转 SUSPENDED；
  resume 恢复为 READY 并**重新计时**。
- DELETED 为终态：任何操作返回 TERMINAL_STATE（HTTP 410），名称可被复用。
- 每次转移在 SQLite 记录 runId（实例短 id + 序号）、原因、虚拟时间戳，
  可按模板名或状态查询实例，按实例查询完整历史。

## 错误语义（错误码 → HTTP）

| 错误码 | HTTP | 含义 / 示例 |
| --- | --- | --- |
| TEMPLATE_VALIDATION | 400 | 模板非法：镜像为空、特性不在白名单、cpu/内存非正或超全局上限 |
| OVERRIDE_INVALID | 400 | 覆盖参数非法：未知字段或超过模板上限，details.field 指明字段 |
| INSTANCE_NOT_FOUND | 404 | 实例或模板不存在 |
| NAME_CONFLICT | 409 | 同名活跃实例已存在（同时只能一个活跃） |
| INVALID_TRANSITION | 409 | 当前状态不允许该操作（如对 READY 实例 resume） |
| TERMINAL_STATE | 410 | 实例已删除（终态），任何操作失败 |
| RESOURCE_EXHAUSTED | 429 | 等待队列已满（maxQueueSize） |
| INTERNAL | 500 | 未预期错误 |

错误响应体：{ "error": { "code", "message", "details" } }，
details 携带定位信息（字段名、期望值/上限、当前状态等），
输入错误、状态冲突、资源耗尽、内部失败可明确区分，不会统一返回成功。

## HTTP API 与请求样例

    POST   /templates                 注册模板
    GET    /templates                 模板列表
    POST   /instances                 供应实例 { name, template, overrides? }
    GET    /instances?template=&status=   按模板/状态查询
    GET    /instances/:name           实例详情
    GET    /instances/:name/history   状态转移历史（runId/原因/时间）
    POST   /instances/:name/resume    挂起 → 就绪（重新计时）
    DELETE /instances/:name           删除（终态）
    GET    /diagnostics               队列长度、并发占用、时钟、配置
    POST   /clock/advance { ms }      推进虚拟时钟（演示/测试钩子）

注册模板：

    curl -X POST http://localhost:3000/templates -H "content-type: application/json" -d '{
      "name": "node-dev", "image": "registry.local/node:20",
      "features": ["git", "node"], "resources": {"cpu": 4, "memoryMb": 8192},
      "idleTimeoutMs": 5000 }'

供应（资源只能向下覆盖；超出模板或未知字段返回 400 并指明字段）：

    curl -X POST http://localhost:3000/instances -H "content-type: application/json" -d '{
      "name": "dev1", "template": "node-dev", "overrides": {"cpu": 2} }'

推进虚拟时钟（供应完成 → 闲置超时自动挂起）并查看历史：

    curl -X POST http://localhost:3000/clock/advance -H "content-type: application/json" -d "{\"ms\": 6000}"
    curl http://localhost:3000/instances/dev1/history

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PORT | 3000 | HTTP 端口 |
| DB_PATH | data/registry.db | SQLite 路径（:memory: 为内存库） |
| FEATURE_WHITELIST | git,docker,node,python,rust,java,go | 特性白名单 |
| MAX_CPU / MAX_MEMORY_MB | 16 / 32768 | 全局资源上限 |
| MAX_CONCURRENT_PROVISIONS | 2 | 全局并发供应上限（超出排队，FIFO） |
| MAX_QUEUE_SIZE | 8 | 等待队列上限（超出返回 429） |
| PROVISION_DURATION_MS | 1000 | 模拟供应耗时（虚拟时间） |

## 复现步骤（干净目录）

1. 安装 Node.js >= 24（node -v 验证）。
2. npm run accept —— 依次演练：非法模板拒绝、覆盖契约、完整生命周期、
   闲置超时挂起与恢复重计时、同名并发唯一成功、并发上限 FIFO 排队、
   查询过滤与 SQLite 持久化；每步打印判定，全部通过退出 0。
3. npm test —— 18 个独立测试，断言具体状态序列、错误类别与字段级 details。
4. npm start + 上方 curl 样例 —— 手动验证 HTTP 层与错误语义。
