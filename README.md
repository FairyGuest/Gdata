# tunnel-lease-A：端口隧道租约管理服务

从固定端口区间分配隧道端口，以**租约（lease）**统一管理端口的占用与释放：
注册分配端口、心跳续期、到期自动回收、显式释放即时生效，并提供转发表与全历史查询。

技术栈：TypeScript + Node.js（>=22.6，原生类型擦除运行 .ts）+ Fastify 5 + SQLite（Node 内置 `node:sqlite`，本地依赖，无外部服务）。所有数据均为本地合成夹具。

## 目录结构与工程边界

| 模块 | 文件 | 职责 |
|---|---|---|
| 契约层 | `src/contract.ts` | 数据形状、错误分类（`LeaseError` + 稳定错误码）、请求体/查询串解析 |
| 时钟边界 | `src/clock.ts` | `Clock` 接口；`SystemClock` / 可注入的 `VirtualClock` |
| 配置层 | `src/config.ts` | 环境变量加载与校验（端口区间、租期、DB 路径、时钟模式） |
| 执行内核 | `src/kernel.ts` | 纯领域逻辑：注册/心跳/释放/到期清扫/查询，不依赖 HTTP |
| 状态适配 | `src/store.ts` | SQLite 适配器，租约全历史持久化，`LEASE ACTIVE PORT` 唯一索引兜底 |
| HTTP 层 | `src/server.ts` | Fastify 路由，HTTP ↔ 契约翻译，错误码 → HTTP 状态映射 |
| 入口 | `src/index.ts` | 可运行服务入口 |
| 日志 | `src/logger.ts` | JSON 行日志，每行带 `runId`，含关键中间状态与判断理由 |
| 测试 | `test/kernel.test.ts` | 内核级生命周期测试（期望值为手算字面量，非由被测实现生成） |
| 验收 | `scripts/accept.ts` | 一键验收：固定顺序演练全部场景，逐步打印请求/响应/判定 |
| 演示 | `scripts/demo.ts` | 本地迷你生命周期演示 |

## 安装与运行

```bash
npm install        # 仅 fastify（+ dev: typescript）；node:sqlite 为 Node 内置
npm start          # 启动服务，默认 127.0.0.1:8787
npm run demo       # 本地演示（内存 SQLite + 虚拟时钟）
npm test           # 内核单元测试（node:test，进程内运行）
npm run typecheck  # tsc --noEmit
npm run accept     # 一键验收：全部通过退出 0，任一失败退出 1 并列出失败场景
```

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TUNNEL_HTTP_PORT` / `TUNNEL_HOST` | `8787` / `127.0.0.1` | HTTP 监听 |
| `TUNNEL_PORT_START` / `TUNNEL_PORT_END` | `20000` / `20009` | 可分配端口区间（闭区间） |
| `TUNNEL_LEASE_TTL_MS` | `30000` | 租期上限：`expiresAt = lastHeartbeat + ttl` |
| `TUNNEL_DB_PATH` | `./data/leases.db` | SQLite 文件（`:memory:` 为纯内存） |
| `TUNNEL_CLOCK` | `system` | `system` 或 `virtual`（虚拟时钟，验收/测试用） |
| `TUNNEL_VIRTUAL_START_MS` | `1000000` | 虚拟时钟起点 |
| `RUN_ID` | 随机 UUID | 运行编号，写入每条日志用于重放 |

## API

- `POST /leases` 体：`{"target": "ssh://host:22", "preferredPort?": 20001}` → `201 {lease}`
  - 带偏好：空闲则占用；被占 → `409 PORT_CONFLICT`，`details.occupant` 附当前占用者
  - 不带偏好：取区间内最小空闲端口；无空闲 → `503 RESOURCE_EXHAUSTED`
- `POST /leases/:id/heartbeat` → `200 {lease}`（`expiresAt = now + ttl`）
- `POST /leases/:id/release`（或 `DELETE /leases/:id`）→ `200 {lease}`，端口立即释放
- `GET /forwarding-table?target=&status=` → `{entries}`（端口、状态、到期时间；status 可区分 `expired`/`released`）
- `GET /leases?port=&status=` → SQLite 全历史查询
- `GET /diagnostics` → runId、时钟模式、当前时间、区间、各状态计数
- `POST /diagnostics/clock/advance` 体：`{"ms": 1000}` → 推进虚拟时钟（仅 `TUNNEL_CLOCK=virtual`，否则 `403 CLOCK_FORBIDDEN`）

### 请求样例

```bash
curl -X POST localhost:8787/leases -H 'content-type: application/json' -d '{"target":"ssh://a:22"}'
curl -X POST localhost:8787/leases/<id>/heartbeat -X POST
curl "localhost:8787/forwarding-table?status=active"
```

## 错误语义

所有错误响应形如 `{"error": {"code", "message", "details"}}`，不会把异常/未知状态统一返回成功：

| code | HTTP | 类别 | 含义 |
|---|---|---|---|
| `INVALID_INPUT` | 400 | 输入错误 | 请求体/查询串不合法（含 Fastify 层 4xx 解析错误） |
| `LEASE_NOT_FOUND` | 404 | 状态冲突 | 隧道 id 不存在 |
| `PORT_CONFLICT` | 409 | 状态冲突 | 偏好端口被占，`details.occupant` 为当前占用者 |
| `LEASE_EXPIRED` | 409 | 状态冲突 | 对已过期租约心跳 |
| `LEASE_RELEASED` | 409 | 状态冲突 | 对已显式释放租约心跳 |
| `LEASE_NOT_ACTIVE` | 409 | 状态冲突 | 对终态租约再次释放 |
| `RESOURCE_EXHAUSTED` | 503 | 资源耗尽 | 区间内无空闲端口 |
| `CLOCK_FORBIDDEN` | 403 | 输入错误 | 系统时钟模式下推进时钟 |
| `INTERNAL` | 500 | 计算失败 | 未预期异常 |

## 租约生命周期规则

- 到期判定：`now > expiresAt` 时租约过期（**恰好 `now == expiresAt` 时心跳仍续期成功**，晚一个 tick 即过期）。
- 过期由每次操作前的 sweep 统一驱动：标记 `expired`（`closeReason=ttl-expired`）并立即释放端口，可被新注册复用。
- 显式释放即时生效（`released` / `closeReason=explicit-release`），此后心跳返回 `409 LEASE_RELEASED`。
- 任意时刻一个端口至多一个 `active` 租约（内核保证 + SQLite 部分唯一索引 `idx_leases_active_port` 双保险）。
- SQLite 保留全历史（行只流转状态、不删除），可按端口/状态查询。

## 日志与重放

内核与 HTTP 层输出 JSON 行日志，含 `runId`、事件名、关键中间状态与判断理由，例如：
`{"event":"lease.expired","leaseId":"...","port":20000,"now":1002001,"reason":"now(1002001) > expiresAt(1002000)"}`。
`npm run accept` 结尾会打印完整内核事件流，可据此重放问题。

## 验收场景（`npm run accept`，固定顺序）

S1 自动分配不重复且升序 → S2 偏好端口授予与 409 冲突（附占用者） → S3 心跳边界（恰好到点续上、晚一步过期） → S4 到期回收与端口复用 → S5 显式释放后心跳失败且端口可再分配 → S6 转发表按目标/状态过滤（expired 与 released 区分） → S7 区间耗尽 503 → S8 输入错误 400 → S9 系统时钟下推进时钟 403。

## 从干净目录复现

```bash
npm install
npm run typecheck   # 类型检查
npm test            # 8 个内核测试，全部通过
npm run accept      # 9 个场景全部 PASS，退出码 0
```

依赖版本：Node >= 22.6（开发用 24.x 验证）、fastify ^5.12.5、typescript ^5.9.3（dev）。SQLite 使用 Node 内置 `node:sqlite`（实验性，启动时有一条 ExperimentalWarning，属预期）。

## 实测结果（本仓库交付前执行）

- `npm run typecheck`：通过，无错误。
- `npm test`：8/8 通过（自动分配唯一性与耗尽、偏好冲突、到期回收复用、心跳边界、释放后再分配、转发表过滤、错误码区分、SQLite 全历史）。
- `npm run accept`：S1–S9 全部 PASS，`RESULT: PASS (all scenarios)`，退出码 0。
