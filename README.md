# OAuth2 授权码模式服务（PKCE + 刷新令牌旋转）

TypeScript + Node.js + Fastify + SQLite（`node:sqlite`）实现的 OAuth2 授权码流程。
所有数据为本地合成夹具（`src/fixtures.ts`），无外部账号与真实业务数据。

## 能力

- 授权码一次性使用：第二次兑换返回 `invalid_grant`，不静默重发
- PKCE（仅 S256）：校验失败授权码**不被消耗**，可用正确 verifier 重试
- `redirect_uri` 与客户端注册值精确匹配（授权与兑换两处都校验）
- 刷新令牌旋转：旧令牌用后即废；重放旧令牌触发家族撤销；并发双用仅一次成功（SQLite 原子 `UPDATE ... WHERE consumed_at IS NULL`）
- 授权码 / 访问令牌 / 刷新令牌三级独立 TTL，时间由注入的 `VirtualClock` 控制
- 错误分类可区分：输入错误 / 状态冲突 / 资源耗尽 / 计算失败

## 工程边界

| 模块 | 职责 |
|---|---|
| `src/contracts.ts` | 模块间数据契约（请求/结果/记录/审计事件） |
| `src/errors.ts` | 错误契约：OAuth 错误码 + 四种类别 + HTTP 状态 |
| `src/config.ts` | 配置层：默认值、环境变量覆盖、校验 |
| `src/clock.ts` | `Clock` 接口、`SystemClock`、`VirtualClock` |
| `src/store.ts` | 状态适配层：SQLite 表结构与原子消费操作 |
| `src/core.ts` | 执行内核：authorize / token / refresh 旋转 / introspect + 审计日志 |
| `src/server.ts` | 契约解析与 HTTP 适配：Fastify 路由 + 诊断接口 |
| `src/fixtures.ts` | 本地合成客户端与用户夹具 |
| `src/index.ts` | 服务入口 |
| `test/oauth2.test.ts` | 独立测试（node:test，10 例） |
| `scripts/accept.ts` | 一键验收（7 场景固定顺序演练） |
| `scripts/demo.ts` | 本地演示 |

## 依赖清单

- Node.js >= 22.5（使用内置 `node:sqlite` 与类型擦除运行 TS）
- fastify 4.29.1（运行时唯一依赖）
- 开发依赖：typescript 5.9.3、@types/node 22.20.4、tsx 4.23.15

## 复现步骤（干净目录）

```bash
npm install        # 安装上述依赖（lockfile 版本见 package.json）
npm run typecheck  # 类型检查
npm test           # 独立测试：10 例，断言具体错误码与失败类别
npm run accept     # 一键验收：7 场景，全部通过退出 0，任一失败非 0
npm run demo       # 本地演示完整流程
npm start          # 启动 HTTP 服务（默认 127.0.0.1:4100）
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OAUTH2_HOST` / `OAUTH2_PORT` | 127.0.0.1 / 4100 | 监听地址 |
| `OAUTH2_DB_PATH` | `:memory:` | SQLite 路径 |
| `OAUTH2_CODE_TTL_MS` | 60000 | 授权码 TTL |
| `OAUTH2_ACCESS_TTL_MS` | 300000 | 访问令牌 TTL |
| `OAUTH2_REFRESH_TTL_MS` | 3600000 | 刷新令牌 TTL |

夹具客户端：`demo-client / demo-secret`，注册回调 `http://localhost:3000/callback`。

## 请求样例

```bash
# 1. 获取授权码（verifier/challenge 为 RFC 7636 附录 B 样例）
curl "http://127.0.0.1:4100/authorize?response_type=code&client_id=demo-client\
&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"

# 2. 兑换令牌
curl -X POST http://127.0.0.1:4100/token -H 'content-type: application/json' -d '{
  "grant_type":"authorization_code","code":"<code>",
  "redirect_uri":"http://localhost:3000/callback",
  "client_id":"demo-client","client_secret":"demo-secret",
  "code_verifier":"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}'

# 3. 刷新旋转
curl -X POST http://127.0.0.1:4100/token -H 'content-type: application/json' -d '{
  "grant_type":"refresh_token","refresh_token":"<rt>",
  "client_id":"demo-client","client_secret":"demo-secret"}'

# 4. 诊断
curl http://127.0.0.1:4100/diag/state
curl http://127.0.0.1:4100/diag/audit
```

## 错误语义

响应体统一为 `{ error, error_description, error_category }`：

| error | HTTP | error_category | 触发条件 |
|---|---|---|---|
| `invalid_request` | 400 | `input_error` | 参数缺失/格式错误、redirect_uri 不匹配、非 S256 |
| `invalid_client` | 401 | `input_error` | 未知 client_id 或密钥错误 |
| `unsupported_grant_type` | 400 | `input_error` | 非 authorization_code / refresh_token |
| `invalid_grant` | 400 | `state_conflict` | 码/令牌不存在、已使用、已过期、PKCE 失败、旋转重放 |
| `temporarily_unavailable` | 503 | `resource_exhausted` | 客户端未消费授权码超出配额 |
| `server_error` | 500 | `computation_failure` | 未预期的内部异常 |

异常与未知状态不会统一返回成功；所有失败都带类别与原因。

## 测试与验收

- `npm test`：10 个用例，断言具体错误码、类别与描述（如双兑换 `invalid_grant/state_conflict`、PKCE 失败后码仍可用、并发旋转恰好一个 200）。PKCE 参考值取自 RFC 7636 附录 B 公开样例，非被测实现生成。
- `npm run accept`：按固定顺序演练 7 个场景（happy path、双兑换、错误 verifier、redirect_uri 精确匹配、三级独立过期、并发旋转、重放撤销），逐步打印请求/响应/判定，全部通过退出 0，任一失败非 0 并指出场景。
- 每次运行生成 `runId`，审计事件（`/diag/audit`）记录运行编号、关键中间状态与判断理由，可据此重放问题。

## 实测结果（2026-10-03）

- `npm test`：10/10 通过
- `npm run accept`：7/7 场景通过，退出码 0
