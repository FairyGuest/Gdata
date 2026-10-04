# JWT 令牌生命周期管理服务

基于 TypeScript + Node.js + Fastify + SQLite（`node:sqlite`，零原生依赖）的 JWT 令牌管理服务。
支持签发（指定有效期与权限范围）、刷新（旧令牌立即作废并颁发新令牌）、主动吊销，
签名算法为 HMAC-SHA256（HS256）。时间全部通过注入的 `VirtualClock` 控制，不依赖系统时钟。

## 依赖清单

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22.5（开发环境为 v24.14.1） | 运行时，需支持 `node:sqlite` 与 `--experimental-transform-types` |
| fastify | 4.29.1 | HTTP 服务 |
| typescript | 5.9.3（dev） | 类型检查（`npm run build`，仅 `--noEmit`） |
| tsx | 4.23.15（dev） | 可选的 TS 运行器 |
| @types/node | 22.20.4（dev） | Node 类型定义 |

SQLite 使用 Node 内置 `node:sqlite`（ExperimentalWarning 属正常）。无生产账号、无外部服务，
所有数据均为本地合成夹具。

## 一键验收

```powershell
npm install        # 或按上述版本准备 node_modules
npm test           # 11 个单元/集成测试，断言具体结果与失败类别
npm run accept     # 11 个固定顺序场景，逐步打印请求/响应/判定；全部通过退出 0，任一失败退出 1
```

验收场景（`test/accept.ts`，使用注入的 VirtualClock，起点 T0=1700000000000ms）：

1. S1 签发：指定 `ttlSeconds` 与 `scopes`，断言 `expiresAtMs == T0 + 60_000`；
2. S2 验证：新令牌返回精确 claims；
3. S3 并发双刷新：同一令牌两个并发 `POST /tokens/refresh`，恰好一个 200，另一个 401 `TOKEN_ROTATED`（或 409 `STATE_CONFLICT`）；
4. S4 已旋转旧令牌再验证 → 401 `TOKEN_ROTATED`；
5. S5 已旋转令牌再刷新 → 401 `TOKEN_ROTATED`；
6. S6 过期边界：推进虚拟时钟到 `exp-1ms` 仍有效，到 `exp` 恰好 401 `TOKEN_EXPIRED`；
7. S7 吊销后验证 → 401 `TOKEN_REVOKED`；
8. S8 非法输入（`ttlSeconds=0`、非法 scope）→ 400 `VALIDATION_ERROR`；
9. S9 篡改签名 → 401 `TOKEN_INVALID_SIGNATURE`；
10. S10 超过每主体活跃令牌上限 → 503 `RESOURCE_EXHAUSTED`；
11. S11 诊断日志含 runId、outcome、reason，可重放每次判定。

## 运行服务

```powershell
npm start          # 默认 127.0.0.1:8787，内存 SQLite
```

配置（环境变量，均有本地默认值，见 `src/config.ts`）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `JWT_SECRET` | `local-dev-secret-change-me` | HMAC-SHA256 密钥（本地开发默认值） |
| `DB_PATH` | `:memory:` | SQLite 文件路径 |
| `MAX_TTL_SECONDS` | `86400` | 签发/刷新 TTL 上限 |
| `DEFAULT_REFRESH_TTL_SECONDS` | `300` | 刷新未指定 TTL 时的默认值 |
| `MAX_ACTIVE_TOKENS_PER_SUBJECT` | `16` | 每主体活跃令牌容量上限 |
| `DIAGNOSTICS_CAPACITY` | `1000` | 诊断事件环形缓冲容量 |

## 请求样例

```powershell
# 签发
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/tokens ``
  -ContentType 'application/json' ``
  -Body '{"subject":"alice","ttlSeconds":60,"scopes":["read:docs","write:docs"]}'
# 验证 / 刷新 / 吊销
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/tokens/verify  -ContentType 'application/json' -Body ('{"token":"' + $t + '"}')
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/tokens/refresh -ContentType 'application/json' -Body ('{"token":"' + $t + '","ttlSeconds":120}')
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/tokens/revoke  -ContentType 'application/json' -Body ('{"token":"' + $t + '"}')
# 诊断
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/diagnostics/events?runId=<runId>'
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/diagnostics/tokens/<jti>'
```

每个响应都带 `runId`（也可用请求头 `x-run-id` 指定），诊断事件按 `runId` 关联，
记录操作、成败、失败原因与关键中间状态，可据此重放问题。

## 错误语义

所有失败响应形如 `{ "ok": false, "runId": "...", "error": { "code", "message", "detail" } }`，
异常或未知状态绝不返回成功。失败类别可区分：

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 请求体未通过契约解析（缺字段、非法 TTL/scope 等） |
| `TOKEN_MALFORMED` | 401 | 不是合法的三段式 JWT 或缺必要 claims |
| `TOKEN_INVALID_SIGNATURE` | 401 | 签名/算法校验失败，或令牌 id 未知 |
| `TOKEN_EXPIRED` | 401 | 当前（虚拟）时间已到达或超过过期时刻 |
| `TOKEN_REVOKED` | 401 | 令牌被主动吊销（与过期同时成立时优先报告吊销） |
| `TOKEN_ROTATED` | 401 | 令牌已被刷新轮换、由新令牌替代（detail 含 `replacedBy`） |
| `STATE_CONFLICT` | 409 | 状态迁移竞争失败（如并发刷新中落败） |
| `RESOURCE_EXHAUSTED` | 503 | 容量上限（每主体活跃令牌数） |
| `COMPUTATION_FAILURE` | 500 | 签名/持久化等计算失败或未预期异常 |

三种失效原因（过期 / 已吊销 / 已旋转）分别对应 `TOKEN_EXPIRED` / `TOKEN_REVOKED` / `TOKEN_ROTATED`，
生命周期检查按 吊销 → 旋转 → 过期 的顺序判定，确保多重原因同时成立时报告最具体的一种。

## 工程结构

```
src/contract.ts     契约解析层：入参校验，产出类型化命令（VALIDATION_ERROR）
src/kernel.ts       执行内核：JWT 签发/验签 + 生命周期状态机，不直接做 I/O
src/store.ts        状态适配层：SQLite 持久化与原子状态迁移（条件 UPDATE + IMMEDIATE 事务）
src/diagnostics.ts  诊断层：带 runId 的结构化事件环形缓冲
src/clock.ts        Clock 接口 / SystemClock / VirtualClock（时间全部注入）
src/config.ts       配置层：环境变量 + 本地默认值
src/server.ts       组合根 + HTTP 适配：错误到 HTTP 的统一映射
src/index.ts        服务入口
test/lifecycle.test.ts  独立测试（node:test），期望值独立计算
test/accept.ts          一键验收脚本（npm run accept）
```

并发正确性：刷新/吊销的状态迁移是 `UPDATE ... WHERE status='active'` 的条件更新，
包在 `BEGIN IMMEDIATE` 事务中；同一令牌的两次并发刷新只有一次能把行从 active 迁走，
落败方得到 `TOKEN_ROTATED` 或 `STATE_CONFLICT`，绝不双双成功。

## 复现步骤（从干净目录）

1. 安装 Node.js >= 22.5；
2. 按上表版本准备依赖（`npm install`，或拷贝等价的 `node_modules`）；
3. `npm run build` 类型检查；`npm test` 运行 11 个测试；`npm run accept` 运行 11 个验收场景；
4. `npm start` 启动服务后按“请求样例”手动演练。

最近一次本地执行结果：`npm test` 11/11 通过；`npm run accept` 11/11 通过（退出码 0）。
