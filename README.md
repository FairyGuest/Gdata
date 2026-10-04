# jwt-lifecycle-service

基于 TypeScript / Node.js / Fastify / SQLite 的 JWT 令牌生命周期管理服务。
支持按有效期与权限范围签发、刷新即旋转（旧令牌立即作废）、主动吊销，
签名算法为 HMAC-SHA256（HS256）。时间由注入的 VirtualClock 控制，不依赖系统时钟。
所有数据均为本地合成夹具，无需任何生产账号或真实业务数据。

## 依赖清单

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22.5（开发验证用 v24.14.1） | 运行时，内置 node:sqlite 与 node:test |
| fastify | ^5.2.0 | HTTP 适配层 |
| typescript | ^5.7.2 | 类型检查（npm run build） |
| @types/node | ^22.10.0 | 类型定义 |

SQLite 使用 Node 内置的 node:sqlite（实验性，启动时会打印 ExperimentalWarning，属正常）。
无原生编译依赖，npm install 即可运行。

## 快速开始（从干净目录复现）

```powershell
npm install        # 安装依赖
npm test           # 运行独立测试（11 个用例，断言具体结果与失败类别）
npm run accept     # 一键验收：12 步场景演练，全部通过退出 0，任一失败非 0
npm run demo       # 内核级最小演示（签发/刷新/过期）
npm start          # 启动 HTTP 服务（默认 127.0.0.1:3000）
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| JWT_PORT | 3000 | 监听端口 |
| JWT_HOST | 127.0.0.1 | 监听地址 |
| JWT_SECRET | local-fixture-secret-do-not-use-in-prod | HMAC 密钥（本地夹具） |
| JWT_DB | :memory: | SQLite 路径，可设为文件路径持久化 |
| JWT_CLOCK | system | system 或 virtual（virtual 启用 VirtualClock 与调试时钟接口） |
| JWT_VIRTUAL_START | 1700000000000 | VirtualClock 起始毫秒时间戳 |
| JWT_RUN_ID | 随机 UUID | 运行编号，写入每条决策日志 |

示例（虚拟时钟模式）：

```powershell
$env:JWT_CLOCK='virtual'; npm start
```

## HTTP 接口

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| POST | /tokens | {"sub":"alice","scope":["read"],"ttlMs":60000} | 201 {token,jti,sub,scope,iat,exp} |
| POST | /tokens/validate | {"token":"..."} | 200 {valid:true,jti,sub,scope,iat,exp} |
| POST | /tokens/refresh | {"token":"..."} | 200 {token,jti,...}（新令牌，旧令牌立即 rotated） |
| POST | /tokens/revoke | {"token":"..."} | 200 {jti,status:"revoked"} |
| GET | /tokens/:jti | - | 200 存储行（诊断接口） |
| GET | /health | - | 200 {status:"ok"} |
| POST | /__clock/advance | {"ms":1000} | 仅 JWT_CLOCK=virtual 时存在，推进虚拟时钟 |
| GET | /__clock/now | - | 仅 virtual 模式，返回当前虚拟时间 |

请求样例：

```powershell
curl -X POST http://127.0.0.1:3000/tokens -H 'content-type: application/json' `
  -d '{"sub":"alice","scope":["read","write"],"ttlMs":60000}'
```

## 错误语义

所有失败响应为 {"error":{"code","message","reason?"}}，绝不把失败统一返回成功。

| code | HTTP | 含义 | reason 取值 |
| --- | --- | --- | --- |
| invalid_input | 400 | 请求契约解析失败（缺字段/类型错/ttlMs 非正数） | - |
| invalid_token | 401 | 令牌本身非法 | malformed（格式错误）/ bad_signature（签名不符，计算校验失败）/ bad_payload（声明结构错）/ unknown_jti（签名有效但库中无此令牌） |
| expired | 401 | 已过期（now >= exp） | expired |
| revoked | 401 | 已被主动吊销 | revoked |
| rotated | 401 | 已被刷新替换（旧令牌再使用） | rotated |
| refresh_conflict | 409 | 并发刷新/吊销竞争失败（CAS 未获胜），reason 为竞争后的实际状态 | active/rotated/revoked |
| internal | 500 | 存储或计算内部失败 | - |

三种失效原因 expired / revoked / rotated 完全可区分。状态检查优先于过期检查：
被吊销或已旋转的令牌即使也已过期，仍报告 revoked / rotated（显式终态优先）。

并发语义：刷新与吊销通过 SQLite 原子比较并设置
（UPDATE ... WHERE status='active'）实现，同一令牌并发两次刷新只会有一个成功，
另一个得到 rotated（串行到达）或 refresh_conflict（CAS 竞争失败）。

## 工程结构

- src/errors.ts — 错误契约（ErrorCode、HTTP 映射、Result 类型）
- src/clock.ts — Clock 接口 / SystemClock / VirtualClock（时间注入）
- src/jwt.ts — HS256 签发与验证（timingSafeEqual 比较）
- src/store.ts — SQLite 状态适配层（schema、原子 CAS 旋转/吊销）
- src/service.ts — 执行内核（issue/validate/refresh/revoke/introspect + 决策日志）
- src/http.ts — Fastify 路由与错误映射（HTTP 适配层）
- src/config.ts — 配置层（环境变量、本地夹具默认值）
- src/index.ts — 服务入口
- test/token-lifecycle.test.ts — 独立测试（参考令牌由测试内独立计算，不经被测实现）
- scripts/accept.ts — 一键验收（npm run accept）
- scripts/demo.ts — 内核演示

## 测试与验收

npm test 覆盖：签发与独立参考签名比对、过期边界（exp-1ms 有效 / exp 处过期）、
吊销后验证、刷新后旧令牌 rotated 且新令牌可用、已旋转令牌再刷新、并发双刷新仅一次成功、
篡改签名、畸形令牌、未知 jti、契约解析失败、决策日志结构。

npm run accept 按固定顺序演练 12 步：签发 → 验证 → 并发双刷新 → 旧令牌复用（validate/refresh）
→ 新令牌验证 → 吊销 → 吊销后验证 → 虚拟时钟推进过期边界 → 篡改签名 → 非法输入，
逐步打印请求、响应与 [PASS]/[FAIL] 判定，全部通过退出 0，任一失败退出 1 并标明失败步骤。

## 诊断日志

内核每次决策输出 JSON 行：{runId, op, jti, decision, reason, at}，
包含运行编号、关键中间状态（如 replaced_by、竞争后的实际状态）与判断理由，可直接用于重放定位。