# env-drift-service

环境配置的层叠合并与漂移对比服务。输入三层配置（基础层 base、环境覆盖层 env、实例补丁层 instance）与一份运行时快照，先级联合并出有效配置，再与快照做结构化对比，产出按点号路径定位的漂移清单。每次合并与对比的输入输出都持久化到 SQLite，可按环境名回放。

## 技术栈与依赖

- **Node.js >= 22.6**（开发验证版本 v24.14.1）：直接以类型擦除方式运行 TypeScript，无需编译步骤
- **TypeScript 5.8.3**（仅用于 `npm run typecheck`）
- **SQLite**：Node 内置 `node:sqlite`（实验性 API，启动时有一条 ExperimentalWarning，属正常）
- **HTTP 层**：默认 `node:http` 适配器，零运行时依赖、离线可复现。Fastify 可实现同一 `AppAdapter` 接口（`src/server/http.ts`）直接替换，路由与内核不变（见文末）
- 全部数据来自 `fixtures/` 本地合成夹具，无生产账号与真实业务数据

```
node -v           # >= 22.6
npm test          # 单元/集成测试（node:test）
npm run accept    # 一键验收：6 个场景固定顺序演练，全部通过退出 0，任一失败非 0
npm run demo      # 本地演示：合并 + 双快照对比 + 回放
npm start         # 启动服务（PORT/HOST/DB_PATH 可配，默认 127.0.0.1:8080，data/env-drift.db）
npm run typecheck # 可选：tsc --noEmit（需 node_modules 中有 typescript）
```

## 合并语义

- 标量键：后层覆盖前层（base -> env -> instance）
- 对象：深合并，递归到叶子
- 数组：整体替换，不做逐元素合并
- `null`：删除标记，把该键从结果中剔除
- 非法层结构拒绝：某层不是 JSON 对象、或任意层级出现空串键，返回 `INPUT_ERROR` 并指明层名（`detail.layer`）与点号路径位置（`detail.path`）

## 漂移分类

在有效配置与运行时快照之间做结构化对比，差异定位到点号路径：

| 类别 | 含义 | 严重度 |
|---|---|---|
| `missing_required` | 有效配置要求的键在快照中缺失 | 最重 |
| `value_mismatch` | 两侧都有该键但值不同 | 居中 |
| `extra_in_snapshot` | 快照多出的键 | 最轻 |

排序：先按严重度降序，同类内按路径字典序（稳定）。无差异返回明确通过标记 `report.status = "PASS"` 且 `drifts = []`。

## HTTP 接口

- `POST /v1/drift-checks` — 请求体 `{ "env": string, "layers": { base, env, instance }, "snapshot": any }`，返回 `{ runId, merge, report }` 并持久化
- `GET /v1/runs?env=<name>` — 按环境名列出历史运行
- `GET /v1/runs/:runId?env=<name>` — 回放某次运行的完整输入（三层来源）与漂移结果；带 `env` 且不匹配时返回 409
- `GET /health`

请求样例：

```sh
curl -X POST http://127.0.0.1:8080/v1/drift-checks -H "content-type: application/json" -d '{
  "env": "staging",
  "layers": {
    "base":     { "http": { "port": 8080 }, "tags": ["core"], "legacy": true },
    "env":      { "http": { "port": 9090 }, "legacy": null },
    "instance": { "tags": ["core", "hotfix"] }
  },
  "snapshot": { "http": { "port": 9090 }, "tags": ["core", "hotfix"], "pid": 4242 }
}'
```

响应（节选）：`merge.effective` 中 `legacy` 被 null 删除、`tags` 被整体替换；`report.drifts` 含 `extra_in_snapshot` 于路径 `pid`。

## 错误语义

所有错误返回 `{ "error": { "category", "message", "detail" } }`，类别与 HTTP 状态一一对应，不会把异常或未知状态统一返回成功：

| category | HTTP | 触发场景 |
|---|---|---|
| `INPUT_ERROR` | 400 | 请求体非 JSON、缺字段、层不是对象、空串键（detail 含 layer/path） |
| `NOT_FOUND` | 404 | 回放不存在的 runId、未知路由 |
| `STATE_CONFLICT` | 409 | 回放时 env 与运行记录不一致、runId 冲突 |
| `RESOURCE_EXHAUSTED` | 413 | 请求体超 1 MiB、合并深度/键数超限 |
| `COMPUTATION_FAILURE` | 500 | 未预期的内部错误（如 SQLite 写入失败） |

## 测试日志与可重放性

服务运行日志为结构化 JSON 行，包含 `runId`、环境名、关键中间状态（每层合并后的键数 trace）与判断理由（如 "no structural differences"），事件序列 `run.start -> run.merged -> run.diffed -> run.persisted`。凭 `runId` 可通过 `GET /v1/runs/:runId` 完整回放当次三层输入与漂移输出。

## 工程结构

```
src/contracts/   数据与错误契约（types.ts, errors.ts）
src/core/        执行内核：merge.ts（级联合并）、drift.ts（漂移对比）、service.ts（编排）
src/state/       状态适配：store.ts（SQLite 持久化与回放）
src/server/      诊断接口：http.ts（适配器契约 + node:http 实现）、app.ts（路由）
src/index.ts     服务入口
fixtures/        本地合成夹具（三层配置 + 漂移/干净两份快照）
tests/           独立测试（合并语义、漂移分类、服务编排、HTTP 映射）
scripts/accept.ts  一键验收；scripts/demo.ts 本地演示
```

## 从干净目录复现

1. 安装 Node.js >= 22.6（验证版本 24.14.1）
2. 无需 `npm install`（零运行时依赖）；类型检查另需 `npm i -D typescript@5.8.3 @types/node@24.0.15`（离线可跳过，不影响运行与测试）
3. `npm test` — 22 个测试全部通过
4. `npm run accept` — 6 个验收场景全部 PASS，退出码 0；任一场景失败退出非 0 并打印失败场景名
5. `npm start` 后按上文请求样例调用

### 验收场景（固定顺序）

1. 深合并 / 数组替换 / null 删除（断言有效配置具体值）
2. 漂移三类分类 + 点号路径 + 严重度排序（断言精确漂移清单）
3. 无漂移返回 PASS 标记
4. 非法层结构拒绝（空串键、非对象层，断言 layer/path）
5. 运行持久化与按 env 回放
6. 错误分类：404 NOT_FOUND、409 STATE_CONFLICT

### 本次验收实测记录（2026-10-07，Node v24.14.1，Windows）

- `npm test`：22 pass / 0 fail
- `npm run accept`：6/6 场景 PASS，退出码 0
- `npm run typecheck`：0 错误（typescript 5.8.3）
- `npm run demo`、`npm start`（/health 返回 {"status":"ok"}）均实测通过

## 换入 Fastify

`src/server/http.ts` 中的 `AppAdapter` 是唯一 HTTP 契约：实现 `listen(port, host)` / `close()`，在 Fastify 实例中把请求归一化为 `HttpRequest` 后调用同一个 `Router.dispatch` 即可，路由、内核、错误映射均无需改动。
