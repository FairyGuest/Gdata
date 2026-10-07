# tunnel-lease-service

端口隧道租约管理服务：管理隧道注册（目标地址 + 可选端口偏好）、心跳续期、显式释放与转发表查询。端口的占用与释放完全由租约到期规则统一驱动。

## 技术栈与依赖

- Node.js **>= 24**（直接运行 TypeScript；内置 node:sqlite，零外部原生依赖）
- TypeScript（tsconfig.json 供编辑器/类型检查；运行时由 Node 原生类型擦除执行）
- Fastify 兼容 HTTP 层：本仓库以本地 vendored 依赖提供（vendor/fastify，经 package.json 的 "fastify": "file:vendor/fastify" 安装）。执行环境无网络，无法从 registry 拉取官方 fastify，故以显式本地依赖实现本项目用到的 API 子集（get/post/delete、inject、listen、reply.code/send）。接口与 Fastify 对齐，有网络时可换成官方包而无需改动 src/ 任何代码。
- SQLite：node:sqlite（Node 内置；启动时的 ExperimentalWarning 可忽略）
- 全部数据为本地合成夹具，无生产账号与真实业务数据。

## 目录结构

- src/contracts.ts — 契约层：请求/响应类型、输入解析与校验（INPUT_ERROR 在此产生）
- src/kernel.ts — 执行内核：分配/续期/释放/惰性过期清扫，注入 Clock，产出带 runId 的运行日志
- src/store.ts — 状态适配接口 LeaseStore
- src/sqliteStore.ts — SQLite 适配器：保存租约全历史，可按 port/status 查询
- src/server.ts — HTTP 层：路由 + 错误分类到状态码的映射
- src/config.ts — 配置层：默认值 + config/default.json + 环境变量覆盖
- src/clock.ts — Clock 接口 / VirtualClock / SystemClock
- src/errors.ts — 错误分类（见下）
- src/index.ts — 服务入口（SystemClock + SQLite + HTTP 监听）
- test/ — node:test 独立测试（断言具体结果与失败类别）
- scripts/accept.ts — 一键验收：固定顺序演练全部场景，逐步打印请求/响应/判定
- scripts/demo.ts — 本地演示（VirtualClock 驱动）
- config/default.json — 默认配置

## 配置

config/default.json，可被环境变量覆盖：

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| portMin / portMax | TUNNEL_PORT_MIN / TUNNEL_PORT_MAX | 20000 / 20009 | 可分配端口区间（含端点） |
| leaseTtlMs | LEASE_TTL_MS | 30000 | 租期上限；expiresAt = lastHeartbeatAt + leaseTtlMs |
| dbPath | DB_PATH | :memory: | SQLite 文件路径 |
| httpHost / httpPort | HTTP_HOST / HTTP_PORT | 127.0.0.1 / 8080 | 监听地址 |

## 运行

    npm install        # 仅链接本地 vendor/fastify，无需网络
    npm start          # 启动服务（真实时钟）
    npm run demo       # VirtualClock 演示完整生命周期
    npm test           # 9 个独立测试（node:test）
    npm run accept     # 一键验收：8 步场景，全过退出 0，任一失败非 0

## API

- POST /tunnels  body {"target":"10.0.0.1:80","preferredPort":20001?} -> 201 {lease}。带偏好且空闲则占用；被占返回 409 + 当前占用者；不带偏好取区间最小空闲端口；区间耗尽返回 503。
- POST /tunnels/:id/heartbeat -> 200 {lease}；到期时刻恰好心跳仍成功（边界含等号），晚 1ms 即过期并返回 409。
- POST /tunnels/:id/release -> 200 {lease}，端口立即可复用。
- GET /forward-table?target=&status= -> {entries:[{leaseId,target,port,status,expiresAt}]}，status 区分 active / expired / released（含两种终态）。
- GET /leases?port=&status= -> SQLite 全历史查询。
- GET /diagnostics/state -> 当前时钟、配置、全部租约与最近运行日志（每条含 runId、关键中间状态与判断理由，可重放问题）。

### 请求样例

    curl -X POST http://127.0.0.1:8080/tunnels -H "content-type: application/json" -d "{\"target\":\"127.0.0.1:5432\"}"
    curl -X POST http://127.0.0.1:8080/tunnels/<leaseId>/heartbeat
    curl -X POST http://127.0.0.1:8080/tunnels/<leaseId>/release
    curl "http://127.0.0.1:8080/forward-table?status=active"
    curl "http://127.0.0.1:8080/leases?port=20000"
    curl http://127.0.0.1:8080/diagnostics/state

## 错误语义

所有失败返回 {"error":{code,message,details,runId}}，绝不把异常或未知状态当成功：

| HTTP | code | 含义 |
|---|---|---|
| 400 | INPUT_ERROR | 契约解析失败（缺 target、端口非整数、非法过滤值、配置非法） |
| 404 | LEASE_NOT_FOUND | 租约 id 不存在 |
| 409 | PORT_CONFLICT | 偏好端口被活跃租约占用，details.occupant 附当前占用者 |
| 409 | LEASE_NOT_ACTIVE | 对已终态租约心跳/释放，details.status 区分 expired / released |
| 503 | RESOURCE_EXHAUSTED | 区间内无空闲端口 |
| 500 | INTERNAL_ERROR | 未预期的计算/持久化失败 |

## 生命周期规则（验收对应）

1. 自动分配不重复、取最小空闲端口；偏好冲突 409 附占用者。
2. 到期未续的租约在下次操作时被惰性清扫为 expired，端口立即可复用。
3. 心跳边界：now <= expiresAt 续期成功，expiresAt = now + leaseTtlMs；晚一步即过期。
4. 显式释放即时生效（released），之后对该租约的心跳返回 409 LEASE_NOT_ACTIVE。
5. 任一时刻一个端口至多一个活跃租约；终态租约保留在 SQLite 全历史中。

## 复现步骤（干净目录）

    npm install
    npm test           # 期望: tests 9 / pass 9 / fail 0
    npm run accept     # 期望: ACCEPTANCE: ALL 8 STEPS PASSED，退出码 0

最近一次执行结果（2026-10-07，Node v24.14.1，Windows）：
- npm test：tests 9, pass 9, fail 0
- npm run accept：8 步全部 PASS，退出码 0
- npm start + 手动请求：register / heartbeat / forward-table 均返回预期结果

