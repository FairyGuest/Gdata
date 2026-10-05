# mock-server-b

HTTP 模拟服务器：按预配置路由规则（URL 模式 + 请求方法 + 可选请求体匹配）返回模拟响应，
支持延迟、状态码、响应头、响应体自定义，并将所有请求落库（SQLite）供事后断言调用顺序与参数。

## 技术栈与运行前提

- **Node.js >= 22.6**（开发验证版本 v24.14.1）：直接运行 TypeScript（类型擦除），无需构建步骤
- **node:http**：HTTP 服务（适配层，见下文"关于 Fastify"）
- **node:sqlite**：请求记录持久化（实验性 API，启动时有一条 ExperimentalWarning，属正常）
- **node:test**：测试框架
- **零 npm 依赖**：`package.json` 无 dependencies，克隆后无需 `npm install`

### 关于 Fastify

需求指定 Fastify，但本仓库交付环境完全离线、npm 缓存为空，无法安装任何第三方包。
为保证"从干净目录按文档即可复现"，HTTP 适配层（`src/adapters/http.ts`）基于 `node:http` 实现，
并与执行内核（`src/core/engine.ts`）完全解耦：内核不感知 HTTP 细节，
联网环境下可将适配层替换为 Fastify 路由注册而不触动其他模块。

## 快速开始

```bash
npm start          # 启动服务（默认 127.0.0.1:8080，加载 config/routes.demo.json）
npm run demo       # 内存服务器演示：通配符、序号响应、延迟、请求记录
npm test           # 21 个独立测试（单元 + 集成）
npm run accept     # 一键验收：7 场景 16 项判定，全过退出 0，任一失败退出 1
```

环境变量：`PORT`（端口，默认 8080）、`MOCK_CONFIG`（路由配置路径）、`MOCK_DB`（SQLite 文件，缺省内存库）。

## 路由配置

`config/routes.demo.json` 示例：

```json
{
  "routes": [
    {
      "id": "user-by-id",
      "method": "GET",
      "path": "/api/users/*",
      "responses": [
        { "status": 200, "headers": { "x-mock": "first" }, "body": { "attempt": 1 } },
        { "status": 200, "headers": { "x-mock": "second" }, "body": { "attempt": 2 } },
        { "status": 500, "body": { "error": "upstream broken" } }
      ]
    }
  ]
}
```

- `path` 通配符：`*` 匹配单段（不跨 `/`），`**` 跨段；多条命中时字面量更多的规则优先
- `responses` 数组按**调用序号**依次返回；第 N 次调用取第 N 个
- 序号耗尽时由 `onExhausted` 决定：`"error"`（默认，返回 500 SEQUENCE_EXHAUSTED）或 `"repeat-last"`
- `bodyMatch`：`equals`（原始体全等）、`contains`（子串）、`json`（JSON 部分深匹配），可组合
- `delayMs`：响应前延迟毫秒数

## 诊断接口（不进入请求记录）

| 接口 | 说明 |
| --- | --- |
| `GET /__health` | 存活探针 |
| `GET /__routes` | 路由表与每条调用计数 |
| `GET /__requests?method=&path=&matched=` | 请求记录（seq 即全局调用顺序） |
| `GET /__requests/count?method=&path=` | 记录计数 |
| `POST /__verify` | 断言 `{ "method", "path", "times"? }` → `{ ok, actual, expected }` |
| `POST /__reset` | 清空全部请求记录与路由调用计数 |

请求样例：

```bash
curl http://127.0.0.1:8080/api/users/9
curl -X POST http://127.0.0.1:8080/__verify \
  -H 'content-type: application/json' \
  -d '{"method":"GET","path":"/api/users/9","times":1}'
```

## 错误语义

所有错误返回统一载荷 `{ "error": { code, category, message, details? } }`，类别可区分：

| category | HTTP | 含义 | 典型 code |
| --- | --- | --- | --- |
| `INPUT_ERROR` | 400 | 配置或请求参数非法 | `ROUTE_METHOD_INVALID`、`VERIFY_PARAMS_INVALID` |
| `NO_MATCH` | 404 | 无路由命中 | `MOCK_NO_ROUTE` |
| `STATE_CONFLICT` | 409（管理）/ 500（模拟执行） | 状态冲突：序号耗尽、路由 id 重复 | `SEQUENCE_EXHAUSTED`、`ROUTE_ID_DUPLICATE` |
| `RESOURCE_EXHAUSTED` | 503 | 记录容量超限（默认 10000 条） | `RECORDER_CAPACITY_EXCEEDED` |
| `COMPUTATION_FAILURE` | 500 | 内部计算失败（模式编译、序列化、未知异常） | `PATTERN_COMPILE_FAILED`、`UNEXPECTED_FAILURE` |

未知异常一律包装为 `COMPUTATION_FAILURE` 返回 500，绝不吞错返回成功。

## 工程结构

```
src/
  contracts/    数据与错误契约（types.ts / errors.ts），所有模块只依赖此层
  config/       契约解析：配置加载与校验（loader.ts）
  core/         执行内核：通配符匹配（pattern.ts）、序号调度（engine.ts）
  state/        状态适配：SQLite 请求记录（recorder.ts）
  adapters/     HTTP 适配：请求解析、错误→状态码映射（http.ts）
  diagnostics/  管理接口（admin.ts）
  server.ts     服务入口（组合各层）
config/         演示路由配置
scripts/        demo / accept / 测试入口
test/           独立测试（node:test）
```

## 测试与验收

- `npm test`：21 个测试，断言具体结果与失败类别（如 `SEQUENCE_EXHAUSTED` 必须是
  `STATE_CONFLICT`、容量超限必须是 `RESOURCE_EXHAUSTED`），含延迟计时（≥190ms）与调用顺序验证。
  参考答案（期望状态码、响应体、顺序）均写在测试内，不由被测核心生成。
- `npm run accept`：固定顺序演练 7 个场景（通配符匹配、序号响应、延迟计时、请求体匹配、
  请求记录与调用顺序、重置、错误类别区分），逐步打印请求/响应/判定理由，
  日志带运行编号 `accept-<id>` 便于重放；全部通过退出 0，任一失败退出 1 并打印失败场景名。

最近一次交付前实测：`npm test` 21/21 通过；`npm run accept` 16/16 判定通过，退出码 0。

## 复现步骤（干净目录）

1. 安装 Node.js >= 22.6（验证版本 v24.14.1）
2. 克隆本目录，无需 `npm install`（零依赖）
3. `npm test` → 应见 `pass 21`
4. `npm run accept` → 应见 `全部场景通过，退出 0`，退出码 0
5. `npm start` 后另开终端执行上方 curl 样例
