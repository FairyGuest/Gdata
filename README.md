# namespace-quota service

模拟集群的命名空间与配额管理服务：节点注册（cpu/内存容量）、命名空间（资源配额上限）、
工作负载放置（首次适配 + FIFO 等待队列），并保证配额与容量两本账守恒。

## 技术栈与依赖

- Node.js >= 24（直接运行 TypeScript，内置 node:sqlite，无原生编译依赖）
- fastify 5.12.5（唯一运行时依赖）
- dev: typescript 5.9.3（类型检查）、@types/node 24
- 全部数据为本地合成夹具，无需任何外部账号或真实业务数据

## 快速开始（干净目录复现）

```bash
npm install        # 安装依赖
npm test           # 单元 + API 集成测试（13 个用例）
npm run accept     # 一键验收：21 步固定顺序演练，全过退出 0，任一失败非 0
npm run demo       # 本地演示脚本（内存 SQLite）
npm start          # 启动服务，默认 127.0.0.1:3100，数据落 cluster.db
npm run typecheck  # tsc --noEmit
```

配置（环境变量）：`HOST`（默认 127.0.0.1）、`PORT`（默认 3100）、`DB_PATH`（默认 cluster.db，`:memory:` 为纯内存）。

## 架构与模块边界

| 模块 | 职责 |
|---|---|
| `src/contracts.ts` | 数据形状、错误分类（ErrorKind）、OpResult/LogEntry 契约 |
| `src/config.ts` | 配置层：host/port/dbPath，环境变量覆盖 |
| `src/core/kernel.ts` | 执行内核：首次适配、配额门、FIFO 队列、守恒核算；纯逻辑无 I/O |
| `src/state/store.ts` | 状态适配：SQLite 放置历史（append-only），按命名空间/节点查询 |
| `src/server.ts` | HTTP 层：Fastify 路由，错误分类到状态码的统一映射 |
| `src/index.ts` | 服务入口 |

内核每个操作返回 `OpResult`：`runId`（运行编号，可重放）、结构化 `logs`
（关键中间状态 + 判断理由）、成功值或分类错误。历史同时落 SQLite。

## 调度语义

- **首次适配**：按节点注册顺序（order 字段）找第一个 cpu 与内存同时够用的节点；同输入同决策。
- **配额先行**：放置前先校验命名空间剩余配额，超出即拒绝并给出各维度缺口
  （`details.deficit = { cpu?, memMb? }`，缺口 = 已用 + 申请 - 配额）。
- **FIFO 队列**：无节点可容纳时入队；每次容量/配额释放（删除负载、删除命名空间）后
  按 FIFO 重试，采用队头阻塞——队头放不下则后续等待，保证严格顺序。
- **双账同步**：节点占用与命名空间占用都由同一负载集合推导，删除负载即同时释放两本账，
  不存在漂移；`GET /diag/conservation` 校验 分配之和 == 节点占用之和 == 命名空间占用之和。
- **级联驱逐**：删除命名空间驱逐其全部负载（含队列中的），逐条记录驱逐日志与 SQLite 历史。

## API 与错误语义

| 错误类别 | HTTP | 含义 |
|---|---|---|
| VALIDATION | 400 | 输入契约解析失败（缺字段、非正数等） |
| NOT_FOUND | 404 | 引用的命名空间/负载不存在 |
| CONFLICT | 409 | 状态冲突（重复命名空间名、重复负载 id） |
| QUOTA_EXCEEDED | 422 | 配额资源耗尽，body 含各维度缺口 |
| INTERNAL | 500 | 未预期的计算失败 |

任何错误都不会被吞成 200；未知异常归入 INTERNAL 而非成功。

### 请求样例

```bash
curl -X POST localhost:3100/nodes -H 'content-type: application/json' \
  -d '{"name":"n1","cpu":4,"memMb":8192}'
curl -X POST localhost:3100/namespaces -H 'content-type: application/json' \
  -d '{"name":"team-a","quotaCpu":10,"quotaMemMb":20480}'
curl -X POST localhost:3100/workloads -H 'content-type: application/json' \
  -d '{"id":"w1","namespace":"team-a","cpu":2,"memMb":2048}'
curl -X DELETE localhost:3100/workloads/w1
curl -X DELETE localhost:3100/namespaces/team-a
```

### 诊断接口

- `GET /diag/state` — 节点/命名空间的容量、已用、剩余，以及等待队列
- `GET /diag/conservation` — 守恒核算：allocations vs nodeUsage vs namespaceUsage，balanced 标志
- `GET /diag/history?namespace=<name>&node=<id>` — SQLite 放置历史（placed/queued/released/evicted，含 runId 与理由）

## 验证覆盖

`npm test`（13 用例）与 `npm run accept`（21 步）共同覆盖：

- 满配额拒绝（422 + 各维度缺口）与释放后队列 FIFO 消化
- 首次适配确定性（同输入同决策，按注册顺序）
- 命名空间级联驱逐（逐条可追溯，容量全部回填）
- 配额与容量守恒核算（分配之和 == 占用之和，期望值手工计算而非由被测实现生成）
- 错误分类：VALIDATION / NOT_FOUND / CONFLICT / QUOTA_EXCEEDED 各自断言

## 最近一次验证结果

- `npm test`：13 pass / 0 fail
- `npm run accept`：ALL 21 CHECKS PASSED，退出码 0
- `npm run typecheck`：通过

