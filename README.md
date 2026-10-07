# preview-env-lifecycle

预览环境即建即用的生命周期服务：从环境模板（服务集合 + 参数默认值）实例化按分支隔离的临时环境，管理创建互斥、存活时限（TTL）与配额池。全部数据与外部参与者均为本地合成夹具，无需任何生产账号。

## 技术栈与运行前提

- **Node.js >= 22.5**（开发验证使用 v24.14.1）：TypeScript 通过 Node 原生 type-stripping 直接运行，无需编译步骤；SQLite 使用内置 `node:sqlite`。
- **Fastify ^5.2.0**：声明在 `package.json` 依赖中。HTTP 层是可替换适配器（`src/http/routes.ts` 为共享路由契约）：`npm install` 成功后服务自动使用 Fastify 适配器（`src/http/fastify-app.ts`）；在离线环境（fastify 未安装）自动回退到零依赖的 `node:http` 适配器（`src/http/node-app.ts`），两者路由与错误语义完全一致。
- 除 fastify 外无其他运行时依赖；测试与验收脚本零依赖。

## 快速开始（从干净目录复现）

```bash
npm install        # 可选但推荐：安装 fastify；离线可跳过，自动回退 node:http
npm test           # 运行 11 个独立生命周期测试（node:test，进程内执行）
npm run accept     # 一键验收：启动真实 HTTP 服务，按固定顺序演练全部场景
npm start          # 启动服务，默认 http://127.0.0.1:4180
npm run demo       # VirtualClock 演示：虚拟推进时间观察到期回收
```

`npm run accept` 全部通过退出 0；任一检查失败退出 1 并打印失败场景名与具体请求/响应。

## 配置

`config/default.json`（可用环境变量 `PREVIEW_ENV_CONFIG` 指定覆盖文件深合并）：

- `template`：模板名、服务集合、参数声明（`type` + `default`）、`defaultTtlSeconds` / `maxTtlSeconds`
- `quota.maxActivePerUser`：每用户活跃环境配额（默认 2）
- `renew.maxRenewals`：每环境可续期次数（默认 1）
- `database.file`：SQLite 文件（默认 `data/preview-env.db`，测试用 `:memory:`）

## API 与请求样例

```bash
# 创建（201 新建 / 200 幂等命中）
curl -X POST localhost:4180/environments -H 'content-type: application/json' -d \
  '{"owner":"alice","branch":"feat/login","overrides":{"web.replicas":2},"ttlSeconds":3600}'

# 部署完成回调（DEPLOYING -> ACTIVE）
curl -X POST localhost:4180/environments/env-xxxx/deploy-complete

# 续期（仅一次，延长一个 TTL）
curl -X POST localhost:4180/environments/env-xxxx/renew

# 删除；DEPLOYING 中需 force + reason
curl -X DELETE 'localhost:4180/environments/env-xxxx?force=true&reason=deploy+stuck'

# 诊断
curl 'localhost:4180/diagnostics/environments?branch=feat/login'
curl 'localhost:4180/diagnostics/environments?status=RECLAIMED'
curl 'localhost:4180/diagnostics/environments/env-xxxx/transitions'
curl 'localhost:4180/diagnostics/audit?envId=env-xxxx'
curl -X POST localhost:4180/admin/sweep   # 手动触发到期回收（服务也按 sweepIntervalMs 自动回收）
```

## 实例化与互斥语义

- 创建时模板默认值与 `overrides` 合并为有效配置；未知参数、类型不符、非法 TTL 均被拒绝并指明具体参数名。
- 每个环境分配全局唯一短标识（`env-` + 8 位十六进制）。
- 同一分支同一时刻只允许一个活跃（DEPLOYING/ACTIVE）环境：
  - 同分支 + 相同有效参数（按规范化哈希判定，显式传默认值等同于不传）→ 幂等返回现有环境（200，`idempotent: true`）。
  - 同分支 + 不同参数 → 409 `BRANCH_PARAM_CONFLICT`，`details.existingEnvId` 附现有环境标识。
- 每用户活跃环境数受配额限制，超出返回 409 `QUOTA_EXCEEDED`，`details` 含 `used`/`max` 当前占用。
- 到期由 sweeper 自动回收：状态置 `RECLAIMED` 并释放配额；回收前可续期一次（`renew.maxRenewals`），续期延长一个 TTL。
- DEPLOYING 中禁止普通删除（409 `DELETE_LOCKED`）；`force=true` 且带非空 `reason` 可强制删除，强制原因写入审计日志（`action=delete, outcome=ALLOW, details.forceReason`）。
- SQLite 持久化环境当前投影（`environments`）+ 全量状态转移历史（`environment_events`）+ 审计日志（`audit_log`，含运行编号 runId、动作、ALLOW/DENY、判定理由），支持按分支或状态查询。

## 错误语义

错误响应统一为 `{ "error": { "code", "message", "details" } }`：

| code | HTTP | 含义 |
|---|---|---|
| `UNKNOWN_PARAM` | 400 | 覆盖参数未在模板声明，`details.param` 指明 |
| `PARAM_TYPE_MISMATCH` | 400 | 类型不符，`details` 含 param/expected/actual |
| `INVALID_TTL` | 400 | TTL 非正整数或超过上限 |
| `INVALID_REQUEST` | 400 | 缺少 owner/branch 等必填字段 |
| `FORCE_REASON_REQUIRED` | 400 | 强制删除未提供原因 |
| `BRANCH_PARAM_CONFLICT` | 409 | 分支已被不同参数的环境占用，附 existingEnvId |
| `QUOTA_EXCEEDED` | 409 | 配额耗尽，附 used/max |
| `DELETE_LOCKED` | 409 | DEPLOYING 中普通删除 |
| `INVALID_STATE` | 409 | 非法状态转移（重复续期、续期已回收环境等） |
| `ENV_NOT_FOUND` | 404 | 环境不存在 |
| `INTERNAL` | 500 | 未预期错误（不会吞成成功） |

## 工程结构

```
src/contract/   契约层：错误契约(errors.ts)、数据契约(types.ts)、模板解析与参数校验(template.ts)
src/core/       执行内核：生命周期规则(engine.ts)、注入时钟(clock.ts)、短标识(idgen.ts)
src/store/      状态适配：SQLite 持久化与环境/转移/审计查询(sqlite.ts)
src/http/       传输层：共享路由契约与错误映射(routes.ts)、Fastify 适配器、node:http 适配器
src/config.ts   配置层；src/server.ts 服务入口
scripts/        accept.ts 一键验收、demo.ts VirtualClock 演示
tests/          engine.test.ts 独立测试（硬编码期望值，非由被测实现生成）
config/         default.json 默认配置
```

## 验证记录（本次交付实际执行）

- `node tests/engine.test.ts`：11/11 通过（幂等/冲突区分、参数校验、到期回收与续期、配额、删除锁与强制删除审计、查询）。
- `node scripts/accept.ts`：6 个场景全部 PASS，退出码 0（运行编号 `run-d4f3a3f8`，适配器 node:http 回退）。
- `node scripts/demo.ts`：VirtualClock 推进 121s 后 sweep 回收，转移历史 `null->DEPLOYING->ACTIVE->RECLAIMED` 完整。

