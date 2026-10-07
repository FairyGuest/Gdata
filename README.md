# env-drift-service

环境配置的层叠合并与漂移对比服务。输入三层配置（基础层 base、环境覆盖层 env、实例补丁层 instance）与一份运行时快照，先算出有效配置，再对比出按点号路径定位的漂移清单。每次合并与对比的输入输出都持久化到 SQLite，可按环境名回放任一次运行。

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22.18（开发验证用 24.14.1） | 运行时；直接用 Node 原生类型剥离运行 .ts，无需 tsx/编译步骤 |
| fastify | 5.12.5 | HTTP 诊断接口 |
| typescript | 5.9.3（dev） | 仅做类型检查（npm run typecheck） |
| @types/node | 24.19.0（dev） | 类型定义 |
| SQLite | Node 内置 node:sqlite | 运行记录持久化，无外部数据库 |

所有数据均为本地合成夹具（fixtures/），不需要任何生产账号或真实业务数据。

## 目录结构

- src/contract/ 契约解析：类型、错误码（types.ts），层结构与请求体校验（validate.ts）
- src/core/ 执行内核：层叠合并（merge.ts）、漂移对比（drift.ts）
- src/state/ 状态适配：SQLite 运行记录存取（store.ts）
- src/diag/ 诊断接口：Fastify 路由与错误映射（server.ts）
- src/index.ts 服务入口
- fixtures/ 三层配置与两份快照（有漂移 / 无漂移）
- test/ 独立测试（合并语义、漂移分类、HTTP API）
- scripts/accept.ts 一键验收脚本
- install-offline.cjs 本环境专用的离线依赖安装辅助脚本（npm 缓存不可用时参考，非必需）

## 合并语义

1. 标量键：后层覆盖前层（base < env < instance）。
2. 对象：深合并，递归到叶子。
3. 数组：整体替换，不做逐元素合并。
4. 值为 null：删除标记，把该键从结果中剔除（嵌套层同样生效）。
5. 层结构非法即拒绝：某层不是对象、或任意深度出现空串键，报 INVALID_LAYER 并指明层名与点号路径。

## 漂移对比语义

在有效配置（expected）与运行时快照（actual）之间做结构化对比，差异定位到点号路径，分三类，严重度从重到轻：

1. missing：必填键在快照中缺失（最重）
2. mismatch：值不同（含类型变化、数组不等）
3. extra：快照多出的键（最轻；对象型多余键展开到叶子路径）

排序：先按类别严重度，再按路径字典序，稳定确定。无差异时返回明确的通过标记 status: "pass"。

## 错误语义

所有错误返回统一结构 { "error": { "code", "message", "details?" } }，不会把异常或未知状态统一返回成功：

| code | HTTP | 含义 |
| --- | --- | --- |
| INVALID_INPUT | 400 | 请求体缺字段、env 为空、snapshot 不是对象等输入错误 |
| INVALID_LAYER | 422 | 层结构非法；details 含 layer（base/env/instance）与 path |
| NOT_FOUND | 404 | 回放不存在的 runId |
| STATE_CONFLICT | 409 | 状态冲突（保留，当前接口未触发） |
| RESOURCE_EXHAUSTED | 413 | 请求体超过 1 MiB 限制 |
| COMPUTATION_FAILURE | 500 | SQLite 读写失败等计算/存储失败 |

## 运行日志

每次评估生成 runId（UUID），服务日志记录 runId、env、逐层合并中间状态（applied/deleted 键数）、漂移分类计数与判定结论；同一 runId 可通过 GET /api/runs/:runId 完整回放输入（三层 + 快照）与输出（有效配置 + 漂移清单 + 合并日志）。

## API

- GET /health 健康检查
- POST /api/evaluations 提交 { env, layers: { base, env, instance }, snapshot }，返回 201 { runId, effective, drift, mergeLog }
- GET /api/runs?env=<name> 按环境名列出运行
- GET /api/runs/:runId 回放某次运行的完整输入输出

## 复现步骤（从干净目录）

1. 安装 Node.js >= 22.18（验证版本 24.14.1）。
2. 安装依赖：npm install（离线环境可用 install-offline.cjs 从本机 npm 缓存提取，见脚本头部注释）。
3. 类型检查：npm run typecheck
4. 单元测试：npm test（18 个用例，覆盖深合并 / 数组替换 / null 删除 / 三类漂移 / 通过标记 / 非法层拒绝 / API 回放）
5. 启动服务：npm start（默认 127.0.0.1:3000，数据库 data/env-drift.db；可用 PORT、ENV_DRIFT_DB 环境变量覆盖）
6. 一键验收：npm run accept —— 先跑全部单元测试，再启动临时实例按固定顺序演练 9 个场景（健康检查、三层合并语义、三类漂移分类、无漂移通过、两类非法层拒绝、按 env 回放、未知 runId 拒绝），逐步打印请求、响应与判定；全部通过退出 0，任一失败非 0 并指出失败场景。

### 请求样例

POST /api/evaluations

{
  "env": "dev",
  "layers": {
    "base":     { "service": { "port": 8080 }, "tags": ["base"], "old": true },
    "env":      { "service": { "port": 9090 }, "tags": ["dev"], "old": null },
    "instance": {}
  },
  "snapshot": { "service": { "port": 8080 }, "tags": ["dev"] }
}

响应 201：effective.service.port = 9090（标量覆盖）、old 被 null 删除、tags 整体替换为 ["dev"]；drift.items 含 { "path": "service.port", "category": "mismatch", "expected": 9090, "actual": 8080 }。

## 验收结果记录

在本机（Node 24.14.1 / Windows）实际执行：

- npm run typecheck：通过（exit 0）
- npm test：18 个用例全部通过
- npm run accept：9 个场景全部 PASS，输出 "ACCEPTANCE PASSED: all 9 scenarios green"，退出码 0
