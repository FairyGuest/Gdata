# test-data-factory

根据用户定义的数据模式（字段名、类型、约束）生成**可复现**合成测试数据的服务。
同一种子（seed）总是产出完全相同的数据序列；数据集可整体存入 SQLite，之后用种子重新生成并校验一致性。

## 技术栈与运行前提

- **Node.js >= 22.5**（开发验证版本：v24.14.1）。源码为 TypeScript，依赖 Node 内置的类型擦除直接运行，无需编译步骤。
- **SQLite**：使用 Node 内置 `node:sqlite`，零原生依赖。
- **Fastify**：列为 `optionalDependencies`。联网环境执行 `npm install` 后服务自动以 Fastify 适配器启动；离线环境（无法安装依赖）自动回退到零依赖的 `node:http` 适配器，两者路由与错误契约完全一致。当前仓库在无网络环境下验收，使用的是 `node:http` 适配器。

## 快速开始（干净目录复现）

```bash
npm install        # 可选：安装 fastify；离线可跳过，服务仍可运行
npm start          # 启动服务，默认 http://127.0.0.1:4100
npm run demo       # 本地演示：生成 -> 复现 -> 保存 -> 校验 -> 冲突报错
npm test           # 25 个单元/集成测试
npm run accept     # 一键验收：先跑测试，再按固定顺序演练全部场景
```

`npm run accept` 全部通过退出码为 0；任一场景失败退出码非 0，并在输出中标注失败的场景与原因。

## 配置

默认值见 `src/config.ts`，可用 `config/local.json`（见 `config/example.json`）或环境变量 `PORT` / `HOST` / `DB_PATH` 覆盖：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `port` / `host` | 4100 / 127.0.0.1 | 监听地址 |
| `dbPath` | data/factory.db | SQLite 文件（`:memory:` 为内存库） |
| `limits.maxRows` | 10000 | 单次生成行数上限 |
| `limits.maxDepth` | 8 | 嵌套深度上限 |
| `limits.maxArrayItems` | 1000 | 数组 maxItems 上限 |
| `limits.maxPatternAttempts` | 5000 | 正则过滤最大尝试次数 |

## 数据模式（Schema）

```json
{
  "fields": {
    "name":  { "type": "string",  "minLength": 3, "maxLength": 8, "pattern": "^[A-Z]" },
    "age":   { "type": "integer", "min": 18, "max": 65 },
    "role":  { "type": "enum",    "values": ["admin", "user"] },
    "hired": { "type": "date",    "min": "2020-01-01", "max": "2024-12-31" },
    "tags":  { "type": "array",   "items": { "type": "string" }, "minItems": 1, "maxItems": 3 },
    "addr":  { "type": "object",  "properties": { "zip": { "type": "string" } } }
  }
}
```

所有约束均可省略（有默认值）；`object` / `array` 可任意嵌套（受 `maxDepth` 限制）。
带 `pattern` 的字符串通过“生成-过滤”满足正则，超过 `maxPatternAttempts` 次仍无法满足时报 `GENERATION_FAILED`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/generate` | 按 `{seed, count, schema}` 生成数据，不入库 |
| POST | `/datasets` | 生成并以 `id` 整体保存到 SQLite |
| GET | `/datasets` / `/datasets/:id` | 列表 / 读取已保存数据集 |
| POST | `/datasets/:id/verify` | 用保存的种子重新生成并逐字节比对，返回 `{match: true|false}` |
| GET | `/diagnostics/logs?runId=&limit=` | 诊断日志（按运行编号回放） |

### 请求样例

```bash
curl -X POST http://127.0.0.1:4100/generate -H "content-type: application/json" -d "{"seed":42,"count":3,"schema":{"fields":{"age":{"type":"integer","min":18,"max":65}}}}"
```

每个响应都带 `runId`，可用于 `/diagnostics/logs?runId=...` 回放该次运行的关键中间状态与判断理由。

## 错误语义

错误响应统一为 `{ "error": { "code", "category", "message", "details" }, "runId" }`，绝不把失败伪装成成功：

| HTTP | code | category | 触发场景 |
| --- | --- | --- | --- |
| 400 | `SCHEMA_VALIDATION` | input | 输入格式错误：未知类型、非整数边界、非法正则、缺 seed 等 |
| 422 | `CONSTRAINT_CONFLICT` | input | 约束自相矛盾：min>max、minLength>maxLength、空枚举、日期区间倒置等 |
| 404 | `NOT_FOUND` | state | 引用的数据集不存在 |
| 409 | `STATE_CONFLICT` | state | 数据集 id 已存在 |
| 413 | `RESOURCE_EXHAUSTED` | resource | 超出配置上限（行数、嵌套深度、数组长度、请求体大小） |
| 500 | `GENERATION_FAILED` | computation | 计算失败（如正则在限定尝试次数内无法满足） |
| 500 | `INTERNAL` | internal | 未预期异常 |

## 可复现性

生成内核（`src/generator.ts`）只依赖 (schema, seed, limits)，使用 mulberry32 确定性 PRNG
（`src/random.ts`），不涉及时钟与 `Math.random`。同一种子两次生成的结果逐字节一致，
测试中以字面量钉住 seed=42 的首行参考值（非由被测实现运行时生成），任何回归都会使测试失败。

## 工程结构

```
src/
  errors.ts      错误分类学（模块间统一错误契约）
  schema.ts      契约层：模式解析与约束冲突校验
  random.ts      确定性 PRNG
  generator.ts   执行内核：递归生成（纯函数，无 I/O）
  store.ts       状态适配：SQLite 持久化
  service.ts     服务层：路由逻辑与错误映射
  server.ts      服务装配：Fastify 优先，node:http 兜底
  http-server.ts node:http 适配器
  logger.ts      诊断：runId 结构化日志
  config.ts      配置层
  index.ts       服务入口
tests/           独立测试（契约 / 内核 / API 三层）
scripts/demo.ts  本地演示
scripts/accept.ts 一键验收
```

## 验收记录（本仓库实际执行）

- `npm test`：25 通过 / 0 失败（Node v24.14.1）。
- `npm run accept`：step 0（测试）+ step 1–10（健康检查、同种子复现、逐类型约束校验、嵌套递归、约束冲突 422、非法输入 400、保存+种子校验、状态冲突 409、资源耗尽 413、诊断日志回放）全部 PASS，退出码 0。