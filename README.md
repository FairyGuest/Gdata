# mock-server-a

可配置的 HTTP 模拟服务器：按预配置路由规则（URL 模式 + 请求方法 + 可选请求体匹配）返回模拟响应，
支持延迟、状态码、响应头、响应体自定义，并将全部请求记录到 SQLite 供事后断言。

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 22（开发用 v24.14.1） | 运行时；SQLite 用内置 node:sqlite |
| fastify | 5.12.5 | HTTP 服务 |
| typescript | 5.9.3 | 编译（npm run build，源码在 src/，产物在 dist/） |
| tsx | 4.23.15 | 可选的 TS 直跑（本仓库脚本均走 tsc 预编译，不依赖 tsx） |
| @types/node | 24.19.0 | 类型 |

安装：npm install（离线环境用 node scripts/offline-install.mjs，从 npm 缓存解包）。

## 快速开始

```bash
npm install          # 或 node scripts/offline-install.mjs
npm run build        # 编译 TypeScript -> dist/
npm start            # 启动：默认 config/routes.demo.json，端口 3000
node dist/index.js config/routes.demo.json 8080   # 指定配置与端口
```

请求样例：

```bash
curl http://localhost:3000/api/users/42                 # 通配符单段 -> 200 {"user":"wildcard"}
curl http://localhost:3000/api/files/a/b/c.txt          # 通配符多段 -> 200
curl http://localhost:3000/api/seq                      # 第1次 attempt=1，第2次 attempt=2，第3次起 503
curl -X POST http://localhost:3000/api/orders -H 'content-type: application/json' -d '{"type":"vip"}'   # 201
curl http://localhost:3000/__mock/requests              # 查看全部请求记录
curl -X POST http://localhost:3000/__mock/reset         # 清空记录与调用计数
```

## 路由配置（config/routes.demo.json）

```jsonc
{
  "routes": [
    // 单次响应
    { "method": "GET", "path": "/api/users/*", "response": { "status": 200, "body": { "user": "wildcard" } } },
    // 序号响应：同一 URL 多次声明（或用 responses 数组），按调用序号依次消费，超出复用最后一个
    { "method": "GET", "path": "/api/seq", "responses": [
      { "status": 200, "body": { "attempt": 1 } },
      { "status": 503, "body": { "attempt": 2 } }
    ]},
    // 请求体匹配：mode=exact 深度相等；mode=contains 请求体包含子集
    { "method": "POST", "path": "/api/orders",
      "bodyMatch": { "mode": "contains", "expected": { "type": "vip" } },
      "response": { "status": 201, "body": { "order": "vip-created" } } },
    // 延迟与自定义响应头
    { "method": "GET", "path": "/api/slow",
      "response": { "status": 200, "delayMs": 300, "headers": { "x-a": "b" }, "body": { "slow": true } } }
  ]
}
```

- 通配符：* 匹配单段，** 匹配任意深度（含零段），段内也支持 *.png 形式。
- 匹配优先级：字面段 > 段内 * > 整段 * > **。
- 同一 (method, path, bodyMatch) 的多条声明合并为一个序号序列；bodyMatch 不同的同路径条目是独立规则（id 以 #n 消歧）。
- 每次命中返回响应头 x-mock-rule（规则 id）与 x-mock-sequence（调用序号）。

## 诊断接口

| 接口 | 说明 |
|---|---|
| GET /__mock/health | 存活检查 |
| GET /__mock/requests | 全部请求记录（seq 全局有序，含 method/path/query/headers/body/matchedRuleId/respondedStatus/receivedAt） |
| GET /__mock/stats | 总数、未匹配数、各规则命中计数 |
| POST /__mock/reset | 清空全部请求记录与调用计数（序号重新从 1 开始） |

## 错误语义

错误按类别区分，绝不把异常/未知状态统一返回成功：

| category | HTTP | 含义 | 示例 |
|---|---|---|---|
| INPUT_ERROR | 400 | 输入/配置非法 | method 非法、status 越界、delayMs 超上限（30000）、bodyMatch.mode 非法 |
| STATE_CONFLICT | 409 | 状态冲突 | 预留（重复注册冲突） |
| RESOURCE_EXHAUSTED | 507 | 资源耗尽 | 请求记录数超过上限（默认 100000） |
| EXECUTION_FAILURE | 500 | 计算/执行失败 | SQLite 初始化失败、序号解析异常、未知异常兜底 |
| NO_MATCH | 404 | 无匹配路由 | 未配置的路径（同时计入请求记录，matchedRuleId=null） |

错误响应体统一为 { "error": { "category", "message", "detail" } }。

## 工程结构

```
src/contracts/   数据契约(types.ts)与错误契约(errors.ts)，模块间唯一约定
src/config/      配置层：JSON 配置解析与校验(loader.ts)，产出 RouteRule[]
src/core/        执行内核：通配符匹配(matcher.ts)、序号解析/延迟(kernel.ts)
src/state/       状态适配：SQLite 请求记录与命中计数(store.ts)
src/diagnostics/ 诊断接口(routes.ts)：requests/stats/reset/health
src/server.ts    装配层：Fastify + 兜底 mock 路由 + 统一错误映射
src/index.ts     服务入口
config/          路由配置样例
test/            独立测试（node:test，断言具体结果与失败类别）
scripts/         accept.mjs 一键验收 / demo.mjs 本地演示 / offline-install.mjs 离线安装
```

## 测试与验收

```bash
npm test          # 编译并运行全部单元+集成测试（21 个用例）
npm run accept    # 一键验收：启动真实服务，按固定顺序演练 10 个场景
npm run demo      # 本地演示脚本
npm run typecheck # 仅类型检查
```

- 测试覆盖：通配符匹配、序号响应、bodyMatch、延迟计时、请求记录顺序、复位、
  错误类别（INPUT_ERROR / RESOURCE_EXHAUSTED / NO_MATCH）。期望值均为手工写死，不由被测核心生成。
- npm run accept 每步打印运行编号（ACCEPT-<时间>#S<步号>）、实际响应与判定理由；
  全部通过退出 0，任一步失败退出 1 并打印失败场景。
- 沙箱等禁止子进程的环境下，测试脚本使用 --test-isolation=none 在进程内运行，行为一致。

## 复现步骤（干净目录）

```bash
npm install            # 或离线：node scripts/offline-install.mjs
npm run accept         # 构建 + 启动 + 10 场景验收，应输出 ALL 10 STEPS PASSED，退出码 0
npm test               # 应报告 tests 21 / pass 21 / fail 0
```

最近一次实测结果（2026-10-03，Node v24.14.1）：npm test 21/21 通过；npm run accept 10/10 通过，退出码 0。
