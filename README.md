
# oauth2-code-service

OAuth2 授权码模式（authorization_code + PKCE S256）本地服务：一次性授权码、
刷新令牌旋转（旧令牌用后即废）、三级独立过期，时间由可注入的
VirtualClock 控制。全部数据为本地合成夹具，无外部账号依赖。

## 技术栈与依赖

- Node.js >= 22.13（开发验证版本 v24.14.1；使用内置 `node:sqlite` 与原生 TypeScript 类型擦除，无需构建步骤）
- TypeScript 5.6（仅类型检查，`npm run typecheck`）
- Fastify 4.28（HTTP 层）
- SQLite：Node 内置 `node:sqlite`（DatabaseSync，同步 API）
- 测试：Node 内置 `node:test`

安装：`npm install`（唯一运行时依赖为 fastify）。

## 运行

```bash
npm start          # 127.0.0.1:3000，SystemClock + 文件库 oauth2.db
npm test           # 单元/集成测试（node:test，内存库 + VirtualClock）
npm run accept     # 一键验收：固定顺序演练全部场景，全过退出 0，任一失败非 0
npm run typecheck  # tsc --noEmit
```

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `OAUTH_CODE_TTL_SEC` | 60 | 授权码有效期（秒） |
| `OAUTH_ACCESS_TOKEN_TTL_SEC` | 300 | 访问令牌有效期（秒） |
| `OAUTH_REFRESH_TOKEN_TTL_SEC` | 3600 | 刷新令牌有效期（秒） |
| `OAUTH_DB_PATH` | `oauth2.db` | SQLite 路径，`:memory:` 为内存库 |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 监听地址 |

客户端夹具（`src/config.ts` 的 `CLIENT_FIXTURES`）：
`demo-client` → `http://localhost:8080/callback`（精确匹配）。

## 请求样例

授权（PKCE：challenge = base64url(SHA256(verifier))）：

```bash
curl -X POST localhost:3000/authorize -H 'content-type: application/json' -d '{
  "response_type":"code","client_id":"demo-client",
  "redirect_uri":"http://localhost:8080/callback",
  "code_challenge":"x8vG52ukahb_xp8Gz8KVy9ydVbpBWmExYObHQJz_dJM",
  "code_challenge_method":"S256"}'
# -> {"runId":"...","code":"...","redirectUri":"...","expiresAt":...}
```

兑换（上例 challenge 对应 verifier `test-verifier-42`）：

```bash
curl -X POST localhost:3000/token -H 'content-type: application/json' -d '{
  "grant_type":"authorization_code","code":"<code>",
  "redirect_uri":"http://localhost:8080/callback","client_id":"demo-client",
  "code_verifier":"test-verifier-42"}'
# -> {"accessToken":"...","tokenType":"Bearer","expiresIn":300,"refreshToken":"...",...}
```

刷新（旋转：返回新刷新令牌，旧令牌立即作废）：

```bash
curl -X POST localhost:3000/token -H 'content-type: application/json' -d '{
  "grant_type":"refresh_token","refresh_token":"<refreshToken>"}'
```

诊断（按注入时钟判定过期/消耗/作废状态）：

```bash
curl 'localhost:3000/diagnostics/state?code=...&accessToken=...&refreshToken=...'
```

## 错误语义

所有错误响应均含 `runId`（可重放的运行编号）、`error`（OAuth2 错误码）、
`error_category`（工程类别）、`error_description`（判定理由）。不存在
"异常统一返回成功"的路径；未知异常映射为 `server_error/internal`。

| error_category | error | HTTP | 含义 |
|---|---|---|---|
| `input` | `invalid_request` | 400 | 契约解析失败：缺参、response_type/grant_type/method 非法 |
| `state` | `invalid_grant` | 400 | 状态冲突：授权码不存在/已用/过期、PKCE 不符、redirect_uri 不符、刷新令牌已旋转/过期 |
| `state` | `unauthorized_client` | 400 | 未注册 client_id |
| `resource` | `temporarily_unavailable` | 503 | 资源耗尽/不可用（保留类别） |
| `internal` | `server_error` | 500 | 未预期的计算失败 |

关键判定规则：

- 授权码仅可使用一次；第二次兑换返回 `invalid_grant`，不会静默重发令牌。
- PKCE 校验在消耗授权码**之前**进行：校验失败授权码不被消耗，可用正确
  verifier 重试。
- `redirect_uri` 与注册值**精确字符串匹配**（尾部斜杠也算不匹配），且
  兑换时必须与授权请求一致。
- 刷新令牌旋转是原子的（单条条件 UPDATE）：并发使用同一刷新令牌只有
  一个请求成功，其余得到 `invalid_grant`。
- 授权码 / 访问令牌 / 刷新令牌过期时间相互独立，均相对注入时钟判定。

## 工程结构

- `src/contracts.ts` 契约解析层：HTTP body → 类型化请求，输入错误
- `src/core.ts` 执行内核：授权/兑换/旋转的领域判定，仅依赖接口
- `src/store.ts` 状态适配层：SQLite 持久化（Store 接口 + SqliteStore）
- `src/server.ts` Fastify 路由、runId 日志钩子、诊断接口
- `src/clock.ts` Clock 抽象：SystemClock / VirtualClock
- `src/config.ts` 配置层与客户端夹具
- `src/errors.ts` 错误分类法（input/state/resource/internal）
- `test/` 独立测试（node:test，内存库 + VirtualClock）
- `scripts/accept.ts` 一键验收脚本

## 复现步骤（干净目录）

```bash
npm install
npm test        # 7 个测试：双兑换、错误 PKCE、redirect_uri 精确匹配、
                # 三级独立过期、并发旋转、错误类别区分、happy path
npm run accept  # 逐步打印请求/响应/判定；全部 PASS 退出 0
```

测试中的 PKCE 参考向量 `base64url(SHA256("test-verifier-42")) =
x8vG52ukahb_xp8Gz8KVy9ydVbpBWmExYObHQJz_dJM` 为独立预计算的已知答案，
并非由被测实现生成。

最近验证记录（2026-10-02，Node v24.14.1）：`npm test` 7/7 通过；
`npm run accept` 6 个场景全部 PASS，退出码 0。
