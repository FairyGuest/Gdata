# Mutation Testing Service

对输入源码执行预定义代码变换（变异体），逐个运行对应测试套件，统计变异得分率并列出存活变异体。历史结果存入 SQLite，可按文件名或变异类型查询。

## 技术栈与依赖

- **Node.js >= 24**（使用 `node:sqlite`、原生类型擦除直接运行 .ts 文件）
- **TypeScript**：源码即 .ts，Node 24 直接执行，无需编译；tsconfig.json 供编辑器与类型检查
- **SQLite**：Node 内置 `node:sqlite`（DatabaseSync），无原生编译依赖
- **HTTP 层**：`node:http`，路由契约与 Fastify 风格一致（method + path + JSON 出入 + 统一错误信封）。
  本环境离线无法安装 Fastify；如需切换，只需用 Fastify 的路由注册重写 src/http.ts，契约保持不变。
- **运行时第三方依赖：0**。package.json 的 dependencies 为空，克隆后无需 npm install。

## 目录结构

- src/contracts.ts — 模块间数据与错误契约（MutantSpec / RunReport / ApiError / 错误类别）
- src/errors.ts — 错误类别与 HTTP 状态映射
- src/mutators.ts — 变异算子（契约解析/扫描）：EqualityFlip、ArithmeticFlip、CallRemoval
- src/kernel.ts — 执行内核：校验请求、基线校验、逐变异体在隔离工作区副本中执行测试并分类
- src/store.ts — 状态适配层：SQLite 持久化运行报告与逐变异体结果，按 file/mutator/runId 查询
- src/http.ts — 诊断接口（HTTP 路由）
- src/config.ts — 配置层（环境变量覆盖默认值）
- src/index.ts — 服务入口
- tests/ — 独立测试（单元 + 端到端，断言具体结果与失败类别）
- fixtures/ — 验证用项目（被杀 / 存活 / 混合 / 基线失败 / 超时）
- scripts/accept.mjs — 一键验收（npm run accept）
- scripts/demo.mjs — 本地演示（npm run demo）

## 变异算子

| 算子 | 变换 | 例 |
|---|---|---|
| EqualityFlip | `===` ↔ `!==` | a === b → a !== b |
| ArithmeticFlip | 二元 `+` → `-`（排除 ++、+=、一元 +） | a + b → a - b |
| CallRemoval | 删除整行函数调用语句 | console.log(...); → （删除） |

变异体按源码偏移量逐个生成，同一位置可被多个算子命中产生多个变异体。每个变异体在
**独立的工作区副本**中应用并执行测试，原始项目目录永不被修改（天然满足"执行后恢复"）。

## 运行

```bash
npm start          # 启动服务，默认 http://127.0.0.1:4319，DB 在 ./data/mutation.db
npm test           # 运行独立测试（30 个用例，实际执行 fixture 测试套件）
npm run demo       # 演示：对 mixed-project 跑一次变异分析并打印报告
npm run accept     # 一键验收：固定顺序演练全部场景，全过退出 0，任一失败非 0
```

配置（环境变量）：MUTATION_PORT、MUTATION_HOST、MUTATION_DB、
MUTATION_TIMEOUT_MS（默认 10000）、MUTATION_MAX_TIMEOUT_MS（默认 60000）、
MUTATION_TEST_COMMAND（默认 `node --test --test-isolation=none`）、
MUTATION_WORKSPACE_ROOT（默认系统临时目录）。

> 注：默认测试命令带 `--test-isolation=none`，因为在部分沙箱/受限环境中
> Node 测试运行器 fork 子进程会被拒绝；在被测项目里这也更快。

## API

### POST /runs
请求：
```json
{
  "projectDir": "F:/path/to/project",
  "sourceFile": "src/calc.js",
  "testCommand": "node --test --test-isolation=none",
  "timeoutMs": 10000,
  "mutators": ["EqualityFlip", "ArithmeticFlip", "CallRemoval"]
}
```
仅 projectDir、sourceFile 必填。响应（201；基线失败时 200）：
```json
{
  "runId": "R-20261004-0001",
  "status": "completed",
  "score": 0.6667, "total": 3, "killed": 2, "survived": 1, "timeout": 0, "error": 0,
  "survivors": [ { "id": "M003", "mutator": "CallRemoval", "status": "survived", "reason": "...", "preview": "..." } ],
  "mutants": [ "..." ],
  "log": [ "[R-...] baseline: OK (exit=0)", "..." ]
}
```

### GET /runs 与 GET /runs/:runId
列出历史运行 / 按运行编号回放完整报告（含日志）。

### GET /mutants?file=src/calc.js&mutator=CallRemoval&runId=R-...
按文件名、变异类型、运行编号过滤历史变异体。mutator 非法时返回 400 INPUT_ERROR。

### GET /health
健康检查。

## 变异体状态与错误语义

**变异体状态**（mutants[].status）：
- killed — 测试套件失败（退出码非 0），变异被检测到
- survived — 测试套件通过（退出码 0），变异未被检测到 → 测试盲区
- timeout — 测试命令超过 timeoutMs（资源耗尽，如变异造成死循环）
- error — 测试命令无法启动或内核自身异常

**运行状态**（status）：completed | baseline_failed（未变异代码的测试套件
就不通过/超时/无法启动，此时得分无意义，运行中止且不计分）。

**API 错误信封**：`{ "error": { "category": ..., "message": ... } }`，异常或未知状态
绝不会统一返回成功：

| category | HTTP | 含义 | 触发示例 |
|---|---|---|---|
| INPUT_ERROR | 400 / 404 | 请求参数非法或资源不存在 | projectDir 不存在、sourceFile 逃逸项目目录、未知 mutator、未知 runId、非法 JSON |
| STATE_CONFLICT | 409 | 状态冲突 | 同一 projectDir 已有进行中的运行 |
| RESOURCE_EXHAUSTED | 503 | 资源限制 | timeoutMs 超过 MUTATION_MAX_TIMEOUT_MS |
| EXECUTION_FAILED | 500 | 未预期的计算失败 | 未捕获异常 |

**日志与可重放性**：每次运行分配 runId（R-YYYYMMDD-NNNN），日志逐条记录
基线结果、每个变异体的判定及理由（退出码/超时/未检测到），完整报告（含日志与
逐变异体理由）持久化到 SQLite，可用 GET /runs/:runId 原样回放。

## 复现步骤（干净目录验收）

```bash
# 1. 环境：Node.js >= 24（node -v 验证）。无需 npm install（零运行时依赖）。
# 2. 独立测试（实际执行 fixture 的测试套件并断言具体结果）：
npm test
# 3. 一键验收（启动服务 → 10 个场景按固定顺序演练并打印请求/响应/判定）：
npm run accept
# 预期输出末尾：ALL SCENARIOS PASSED，退出码 0；任一场景失败会打印
# "!! scenario failed: <名称>" 并以非 0 退出。
```

验收场景覆盖：变异被杀死（score=1）、变异存活（score=0 且列出存活者）、
混合场景（score=2/3，CallRemoval 存活）、基线失败（baseline_failed）、
死循环变异（timeout）、输入错误（INPUT_ERROR）、资源耗尽（RESOURCE_EXHAUSTED）、
按文件/变异类型查询历史、按 runId 回放、未知运行编号（404）。

## 测试说明

- tests/mutators.test.ts — 变异生成的偏移量/替换文本/ID 序列均为**手工计算**的
  期望值，不由被测实现生成。
- tests/kernel.test.ts — 端到端：对 fixtures 真实执行测试套件，断言具体得分
  （1、0、2/3）、具体存活算子、baseline_failed、timeout，以及 INPUT_ERROR /
  STATE_CONFLICT / RESOURCE_EXHAUSTED 等失败类别。
- tests/store.test.ts — SQLite 持久化与按 file/mutator/runId 查询。
- tests/http.test.ts — HTTP 路由、错误信封与错误类别（不只看"接口能调"）。
