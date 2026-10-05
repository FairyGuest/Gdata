# flaky-detector

不稳定（flaky）测试检测服务：把同一组测试重复运行 N 次，按通过/失败分布把每个测试分类为
**稳定通过 / 稳定失败 / 不稳定**，并给出置信度与建议重试次数。历史检测结果存入 SQLite，
可按测试名查询跨轮次的不稳定趋势。

## 技术栈与依赖清单

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | >= 22.18（开发验证用 v24.14.1） | 唯一运行时依赖；内置 TypeScript 类型擦除直接运行 .ts |
| node:http | 内置 | HTTP 服务层（见下文"关于 Fastify"） |
| node:sqlite | 内置 | SQLite 状态适配层 |
| node:test | 内置 | 测试运行器 |
| 第三方 npm 包 | 无 | `package.json` 零 dependencies，`npm install` 无需联网 |

**关于 Fastify**：目标栈本为 Fastify，但本机 npm/pnpm 均离线且缓存中没有 fastify，
无法安装。HTTP 层被隔离在 `src/server.ts`（路由 + JSON 错误映射），业务模块（契约 /
执行 / 分类 / 存储）与 HTTP 框架无关；联网后 `npm install fastify` 并把 `createApp`
内的路由表迁到 Fastify 即可，其余代码不变。

## 目录结构

- `src/contract.ts` — 契约解析：请求体验证，输入错误与资源限制在此分流
- `src/classifier.ts` — 纯函数分类器：类别、置信度、建议重试次数、判定理由
- `src/executor.ts` — 执行内核：scripted（脚本化结果序列）与 command（真实命令）两类测试
- `src/store.ts` — SQLite 状态适配：rounds / results / classifications 三张表
- `src/server.ts` — 诊断接口（HTTP 路由、统一错误映射）
- `src/config.ts` / `src/index.ts` — 配置层与服务入口
- `test/` — 独立测试（期望值手工计算，不由被测实现生成）
- `scripts/demo.ts` — 本地演示；`scripts/accept.ts` — 一键验收

## 分类与置信度规则

- **stable-pass**：N 次全部通过；置信度 = 1 - 2^-N（一个 50% 不稳定测试恰好全演的概率上界）
- **stable-fail**：N 次全部失败；置信度同上；建议重试 0 次（稳定失败重试无意义）
- **flaky**：有通过有失败；置信度 = 2·min(通过数, 失败数)/N —— 少数派占比越高越不稳定，
  因此 3 次中 1 次失败（0.6667）比 10 次中 1 次失败（0.2）的不稳定置信度更高
- **建议重试次数**：由观测失败率 f 推算，使 f^(retries+1) ≤ 1 - passTarget（默认 0.99），
  即 retries = ceil(log(1-目标)/log(f)) - 1，上限 `FLAKY_MAX_RETRIES`（默认 10）
- 不稳定报告包含通过/失败分布与**首次失败运行序号**（1 起始）；每条运行日志含
  runIndex、outcome、reason，可完整重放

## API

- `POST /v1/runs` — 提交一组测试并执行 N 轮，返回分类报告与运行日志
- `GET /v1/reports/:roundId` — 按轮次 ID 重放历史报告
- `GET /v1/tests/:name/history` — 按测试名查询跨轮次分类趋势
- `GET /health` — 健康检查

请求样例：

```json
POST /v1/runs
{
  "suiteId": "checkout",
  "runs": 6,
  "tests": [
    { "kind": "scripted", "name": "cart.total", "outcomes": ["pass"] },
    { "kind": "scripted", "name": "payment.retry", "outcomes": ["pass", "pass", "fail"] },
    { "kind": "command", "name": "api.smoke", "command": "node --version" }
  ]
}
```

`scripted` 的 outcomes 序列循环使用（如 `["pass","fail"]` 即交替通过失败）；
`command` 以退出码判定（0 通过，非 0 失败）。

## 错误语义

所有错误返回 `{ "error": { "code", "message", "detail?" } }`，不会把异常统一吞成 200：

| code | HTTP | 含义 | 触发示例 |
|---|---|---|---|
| INPUT_ERROR | 400 | 请求契约不合法 | JSON 解析失败、runs=0、缺 suiteId、测试重名、非法 outcome |
| STATE_CONFLICT | 409 | 状态冲突 | 同一 suiteId 已有进行中的轮次 |
| RESOURCE_EXHAUSTED | 429 | 资源超限 | runs 超过 `FLAKY_MAX_RUNS`、测试数超限、body > 1MiB、数据库无法打开 |
| COMPUTATION_FAILED | 502 | 执行/持久化失败 | 命令超时、命令无法 spawn、结果写库失败（该轮次标记为 failed，不进历史） |
| NOT_FOUND | 404 | 资源不存在 | 未知 roundId、无历史的测试名、未知路由 |
| INTERNAL | 500 | 未预期异常 | 兜底，不应在正常操作中出现 |

注意区分：命令**退出码非 0** 是正常的测试失败（计入分类）；命令**无法执行**
（超时 / spawn 失败）才是 COMPUTATION_FAILED。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| FLAKY_PORT | 8080 | 监听端口 |
| FLAKY_DB_PATH | data/flaky.db | SQLite 路径（`:memory:` 为内存库） |
| FLAKY_MAX_RUNS | 50 | 单轮最大运行次数 |
| FLAKY_MAX_TESTS | 200 | 单套件最大测试数 |
| FLAKY_PASS_TARGET | 0.99 | 重试建议的目标通过概率 |
| FLAKY_MAX_RETRIES | 10 | 建议重试次数上限 |
| FLAKY_CMD_TIMEOUT_MS | 30000 | command 测试单次超时 |

## 复现步骤（从干净目录）

```bash
node -v          # 需 >= 22.18，验证环境为 v24.14.1 / npm 11.11.0
npm install      # 零依赖，瞬间完成（仅生成 package-lock）
npm test         # 独立测试：分类器/契约/API 共 30 条
npm run accept   # 一键验收：12 个场景按固定顺序演练，全部通过退出 0
npm run demo     # 本地演示：三类测试的分类报告 + 历史趋势
npm start        # 启动服务（默认 :8080）
```

`npm run accept` 固定顺序演练：S1 健康检查 → S2 全部通过 → S3 全部失败 →
S4 交替通过失败（flaky 分布/首败序号/重试建议）→ S5 置信度对比（3 选 1 败 vs 10 选 1 败）→
S6 跨轮次历史趋势 → S7 轮次报告重放 → S8 输入错误 400 → S9 状态冲突 409 →
S10 资源耗尽 429 → S11 计算失败 502 → S12 未找到 404。每个场景打印请求、响应与判定，
任一失败以非 0 退出并指明场景。

## 验证结果（2026-10-03 实跑记录）

- `npm test`：**30 条测试，29 通过 / 1 跳过 / 0 失败，退出码 0**。
  跳过项为"命令退出码 1 应判为测试失败"——本验证环境（沙箱）禁止派生子进程
  （spawn EPERM），该用例在允许 spawn 的正常环境中执行；测试内做了环境探测并显式跳过，
  不伪造通过。
- `npm run accept`：**12/12 场景 PASS，退出码 0**。其中 S11 在本环境由
  "spawn EPERM" 触发 COMPUTATION_FAILED（在可 spawn 的环境则由 500ms 超时触发），
  两条路径都归一为 502，语义一致。
- `npm run demo`：全通过套件（6/6）→ stable-pass 置信度 0.9844；全失败 → stable-fail；
  `["pass","pass","fail"]` 循环 → flaky，4/2 分布，首败第 3 轮，置信度 0.6667，建议重试 4 次。
