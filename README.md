# compose-orchestrator-B

服务编排描述的校验与启停顺序服务。输入一组服务定义（依赖、监听端口、健康检查夹具、环境变量引用），
校验后输出稳定的启动/停止顺序，按层模拟健康推进，计算单服务变更的最小影响闭包，并把编排定义与
历次计算结果持久化到 SQLite，可按版本查询。

## 技术栈与依赖

- Node.js >= 23.6（直接运行 .ts，内置类型擦除；开发环境为 Node 24.14.1）
- TypeScript 5.8（仅类型检查，`npm run typecheck`）
- Fastify 5（HTTP 诊断接口）
- SQLite：Node 内置 `node:sqlite`（无需原生编译，零外部服务）
- 测试：Node 内置 `node:test`（进程内运行，无额外测试框架）

安装（需要能访问 npm registry；若环境设置了失效代理，请先清掉 HTTP_PROXY/HTTPS_PROXY）：

```bash
npm install
```

## 目录结构

```
src/
  contract/   契约解析：types.ts（数据契约）、errors.ts（错误契约）、parse.ts（结构解析）
  core/       执行内核：validate.ts（环/端口/环境变量校验）、topo.ts（分层拓扑排序）、
              impact.ts（影响闭包）、health.ts（按层健康推进模拟）
  state/      状态适配：store.ts（SQLite 持久化，编排定义 + 历次计算结果，按版本查询）
  diag/       诊断接口：routes.ts（HTTP 路由）、error-handler.ts（错误 -> HTTP 映射）
  server.ts   组装；index.ts 服务入口
fixtures/     本地合成夹具（合法多层图 / 环 / 端口冲突 / 变量缺失 / 健康失败）
test/         独立测试（node:test），断言具体结果与失败类别
scripts/accept.mjs  一键验收脚本（npm run accept）
```

## 运行

```bash
npm start                 # 默认 127.0.0.1:3100，DB_PATH=./data/orchestrator.db
PORT=3199 DB_PATH=:memory: node src/index.ts
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /orchestrations | 解析+校验+计算计划，持久化，返回 { version, runId, layers, startOrder, stopOrder }（201） |
| GET  | /orchestrations/:version/plan | 按版本查询已存储的启动/停止顺序 |
| POST | /orchestrations/:version/startup | 按层模拟启动；一层全部 healthy 才推进下一层；失败夹具使整批停在该层并输出失败定位 |
| POST | /orchestrations/:version/impact | body { "changedService": "db" }，返回受影响闭包 affected 与被跳过的 skipped |
| GET  | /runs/:runId | 诊断：某次计算的输入、结果与关键中间状态日志（可重放） |
| GET  | /health | 存活探针 |

### 服务定义契约

```json
{
  "name": "shop",
  "services": [
    {
      "name": "api",
      "port": 8080,
      "dependsOn": ["db"],
      "outputs": ["API_URL"],
      "env": { "DATABASE_URL": "${DB_URL}" },
      "healthCheck": { "kind": "fixture", "result": "healthy" }
    }
  ]
}
```

- `env` 值中的 `${KEY}` 必须出现在某个服务的 `outputs` 中，否则拒绝。
- `healthCheck.result: "failing"` 是失败夹具，用于演练健康检查失败路径。

### 请求样例

```bash
curl -X POST http://127.0.0.1:3100/orchestrations \
  -H 'content-type: application/json' \
  -d @fixtures/valid-multi-layer.json
# => 201 { "version": 1, "runId": "...", "startOrder": ["cache","db","api","worker","gateway"], ... }

curl http://127.0.0.1:3100/orchestrations/1/plan
curl -X POST http://127.0.0.1:3100/orchestrations/1/startup
curl -X POST http://127.0.0.1:3100/orchestrations/1/impact -H 'content-type: application/json' -d '{"changedService":"db"}'
```

## 错误语义

所有错误返回 `{ "error": { "code", "message", "details" } }`，类别可区分，绝不把异常统一返回成功：

| code | HTTP | 含义 |
| --- | --- | --- |
| CONTRACT_PARSE_ERROR | 400 | 请求体不是合法 JSON，或服务定义结构/类型不合法 |
| VALIDATION_CYCLE | 422 | 依赖图成环；details.cycle 为环上服务名序列，如 ["a","c","b","a"] |
| VALIDATION_PORT_CONFLICT | 422 | 端口冲突；details.conflicts 给出冲突端口与双方服务名 |
| VALIDATION_MISSING_ENV | 422 | 环境变量引用了未在任何服务 outputs 中声明的键 |
| VALIDATION_UNKNOWN_DEPENDENCY | 422 | 依赖了未定义的服务 |
| NOT_FOUND | 404 | 版本、runId 或服务名不存在 |
| STATE_CONFLICT | 409 | 状态冲突，如查询没有任何已存计算结果的版本 |
| RESOURCE_EXHAUSTED | 507 | 请求体超过配置上限（bodyLimit） |
| COMPUTATION_FAILED | 500 | 未预期的内部计算失败 |

## 排序与推进语义

- 启动顺序 = 依赖的分层拓扑排序：被依赖者先启动；同层（无相互依赖）按服务名字典序，输出稳定。
- 停止顺序 = 启动顺序的严格逆序。
- 启动推进按层进行：一层全部 healthy 才推进下一层；某服务健康检查为失败夹具时整批停在该层，
  输出失败定位（层号、失败服务、原因），后续层标记 blocked。
- 单服务变更的影响集合 = 该服务 + 传递依赖它的服务闭包；未受影响服务列入 skipped。

## 测试与验收

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test，21 个用例，断言具体顺序/闭包/错误类别
npm run accept      # 一键验收：11 个场景按固定顺序演练，逐步打印请求/响应/判定，
                    # 全部通过退出 0，任一失败非 0 并指出失败场景
```

验收场景覆盖：合法多层图的稳定顺序（含同层字典序）、环检测与定位、端口冲突、变量缺失、
单服务变更影响闭包、健康失败整批停止、非法 JSON、未知版本/服务、运行日志检索、SQLite 重启持久化。

干净目录复现：

```bash
npm install && npm run typecheck && npm test && npm run accept
```

最近一次执行结果：typecheck 0 错误；测试 21/21 通过；验收 11/11 通过（退出码 0）。
