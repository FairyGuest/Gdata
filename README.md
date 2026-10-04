# SBOM 漏洞扫描服务

输入一组软件包及其依赖关系，解析完整传递依赖图，将图中所有包（含传递依赖）与本地漏洞库按
**包名 + 语义化版本范围** 匹配，按严重程度排序输出漏洞报告，并附从根包到漏洞包的依赖路径。

## 技术栈与依赖清单

- TypeScript（Node.js ≥ 22.6 原生类型擦除直接运行 `.ts`，无需编译步骤；开发环境为 Node v24.14.1）
- HTTP 层：`src/server/fastify-lite.ts` —— Fastify 兼容的最小 API 子集
  （`get/post`、路径参数、JSON、`inject`、`listen`）。本仓库交付环境离线，无法安装 fastify；
  接口与 fastify 对齐，有网环境 `npm i fastify` 后可平移替换，路由层（`routes.ts`）无需改动。
- SQLite：Node 内置 `node:sqlite`（`DatabaseSync`），零外部依赖。
- 测试：Node 内置 `node:test` + `node:assert`。
- **运行时第三方依赖：无**（`package.json` dependencies 为空），干净目录离线即可复现。

## 目录结构（工程边界）

| 层 | 位置 | 职责 |
|---|---|---|
| 契约层 | `src/contract/types.ts` / `src/contract/errors.ts` | 模块间数据契约与错误分类契约 |
| 执行内核 | `src/core/semver.ts` `graph.ts` `matcher.ts` `scanner.ts` | 语义化版本、依赖图解析、漏洞匹配、扫描编排 |
| 状态适配层 | `src/state/store.ts` | SQLite：漏洞库、扫描记录、运行日志 |
| 诊断接口 | `src/diagnostics/logger.ts` | runId 结构化 JSONL 日志（文件 + SQLite 双写） |
| 服务入口 | `src/server/main.ts` `routes.ts` `fastify-lite.ts` | HTTP 路由与错误映射 |
| 配置层 | `src/config.ts` | 环境变量覆盖的集中配置 |
| 夹具 | `fixtures/` | 本地合成包注册表、漏洞库、示例请求 |
| 测试 | `test/` | 独立测试，参考答案硬编码 |

## 错误语义（失败类别可区分，绝不统一返回成功）

| 类别 | HTTP | 含义 | 示例 |
|---|---|---|---|
| `INPUT_ERROR` | 400 | 请求契约不合法 | 缺 roots、版本非 major.minor.patch、范围语法错误、依赖在注册表不存在、范围无可满足版本 |
| `STATE_CONFLICT` | 409 | 状态冲突 | 重复 `scanId` |
| `RESOURCE_EXHAUSTED` | 413 | 资源耗尽 | 依赖图节点数超 `maxNodes`、展开深度超 `maxDepth` |
| `COMPUTATION_FAILURE` | 500 | 未预期的内部计算失败 | 兜底类别，带 runId 可回放日志 |

错误响应体：`{ "error": { "category", "message", "details?", "runId?" } }`。
扫描中途失败时扫描记录落库为 `FAILED`（可用 `GET /scans/:scanId` 查证）。

## 核心规则

- **版本比较**：严格按 major.minor.patch 数值比较（`1.10.0 > 1.9.0`），禁止字符串字典序。
  范围语法：`*`、精确版本、`>= <= > < =`（空格分隔为 AND）、`^x.y.z`、`~x.y.z`。
- **依赖解析**：每个依赖范围取注册表中满足条件的最高版本；循环边记录到报告的
  `cycles` 中但不展开、不死循环；共享子图只展开一次。
- **漏洞匹配**：图中**所有**节点（含传递依赖）逐一与漏洞库匹配；结果按
  CRITICAL > HIGH > MEDIUM > LOW 排序；每个 finding 附根包到漏洞包的依赖路径（最多 `maxPaths` 条）。

## 接口

- `POST /scans`：执行扫描。请求体见下方样例；成功返回 201 + 报告。
- `GET /scans/:scanId`：查询扫描记录（status: RUNNING/COMPLETED/FAILED）。
- `GET /vulnerabilities`：列出漏洞库。
- `GET /diagnostics/runs/:runId/logs`：按 runId 回放结构化诊断日志。
- `GET /health`：健康检查。

### 请求样例

```json
{
  "scanId": "demo-scan-001",
  "roots": ["app@^1.0.0"],
  "registry": [
    { "name": "app", "version": "1.0.0", "dependencies": { "lib-a": "^1.0.0" } },
    { "name": "lib-a", "version": "1.2.0", "dependencies": { "lib-b": ">=1.0.0 <2.0.0" } }
  ],
  "options": { "maxNodes": 10000, "maxDepth": 100, "maxPaths": 5 }
}
```

完整可运行的请求体 = `fixtures/scan-request.json` 的字段 + `fixtures/registry.json` 作为 `registry`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SBOM_PORT` / `SBOM_HOST` | 8787 / 127.0.0.1 | 监听地址 |
| `SBOM_DB_PATH` | data/sbom.sqlite | SQLite 路径，`:memory:` 为内存库 |
| `SBOM_LOG_DIR` | logs | 诊断日志目录（run-<runId>.jsonl） |
| `SBOM_MAX_NODES` / `SBOM_MAX_DEPTH` / `SBOM_MAX_PATHS` | 10000 / 100 / 5 | 资源上限 |

## 复现步骤（干净目录）

```bash
# 无需 npm install（零外部依赖）；Node >= 22.6
npm test          # 21 个独立测试：semver 边界/深链/循环/排序/错误类别/诊断日志
npm run accept    # 一键验收：9 个场景按固定顺序演练，全部通过退出 0，任一失败非 0 并指出场景
npm run demo      # 本地演示：起服务、发真实 HTTP 请求、打印排序后的报告与依赖路径
npm start         # 常驻服务（默认 127.0.0.1:8787，启动时把 fixtures 漏洞库种子写入 SQLite）
```

`npm start` 后手动请求示例：

```bash
curl -X POST http://127.0.0.1:8787/scans -H "content-type: application/json" -d @request.json
```

## 验收场景（npm run accept 固定顺序）

1. 深层传递依赖漏洞：6 层传递链上的 `lib-e@2.1.5`（VULN-1001）必须报出且路径正确
2. 版本边界恰好包含：`<=2.1.5` 命中解析出的 `2.1.5`
3. 版本边界恰好不包含：`<2.1.5`、`<1.10.0` 不得命中（后者防字典序比较）
4. 循环依赖：`util-right -> util-left` 循环边记录但不展开，扫描正常完成
5. 严重度排序：CRITICAL,HIGH,MEDIUM,LOW,LOW
6. 输入错误 → 400 INPUT_ERROR
7. 状态冲突 → 409 STATE_CONFLICT
8. 资源耗尽 → 413 RESOURCE_EXHAUSTED
9. 诊断日志可按 runId 重放（scan.start/graph.resolved/cycle.detected/match.found/scan.complete）

## 本次交付验证结果（如实记录）

- `npm test`：21 通过 / 0 失败（Node v24.14.1, Windows）
- `npm run accept`：9/9 场景 PASS，退出码 0
- `npm run demo`：退出码 0，输出 5 条按严重度排序的 finding 与完整依赖路径
- 已知说明：`node:sqlite` 为实验特性，启动时有 ExperimentalWarning（不影响功能）；
  沙箱环境 `node --test` 默认子进程隔离受限，测试脚本使用 `--test-isolation=none` 在进程内运行。
