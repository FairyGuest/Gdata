# cert-chain-service

证书链验证服务：给定一组证书（主题、签发者、有效期、密钥用途），验证目标证书到根证书的完整信任链，
逐级检查有效期，并按剩余有效期给出续期建议。CA 签名用 HMAC-SHA256 模拟，时间通过注入的
VirtualClock 控制，所有数据均为本地合成夹具，无需生产账号或真实业务数据。

## 技术栈与依赖

- Node.js >= 22.6（开发使用 v24.14.1；SQLite 使用内置 `node:sqlite`，TypeScript 由 Node 原生类型擦除直接运行，均无原生依赖）
- TypeScript 5.5+（仅类型注解，运行期由 Node 原生擦除）、Fastify 5

安装：

```bash
npm install
```

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/domain/types.ts` | 领域契约：证书、验证结果、失败码、错误分类 |
| `src/clock/clock.ts` | Clock 接口、VirtualClock（可注入时间）、SystemClock |
| `src/core/hmac.ts` | 规范载荷与 HMAC-SHA256 签名/校验 |
| `src/core/chainValidator.ts` | 执行内核：纯函数链验证 + 续期建议 |
| `src/adapters/sqliteStore.ts` | 状态适配：证书与运行日志的 SQLite 持久化 |
| `src/http/server.ts` | 诊断接口：契约解析、错误分类映射、路由 |
| `src/fixtures/caFixtures.ts` | 本地合成 CA 夹具（根/中间/叶三级链） |
| `src/config.ts` | 配置层：环境变量与默认值 |
| `src/index.ts` | 服务入口 |
| `scripts/demo.ts` | 本地演示脚本 |
| `scripts/accept.ts` | 一键验收脚本（`npm run accept`） |
| `test/` | 独立测试（node:test，期望值手工计算，非内核自生成） |

## 运行

```bash
npm start        # 启动服务，默认 http://127.0.0.1:8787
npm run demo     # 内存模式演示四大场景
npm test         # 执行独立测试
npm run accept   # 一键验收：固定顺序演练全部场景，全过退出 0，否则非 0
npm run typecheck
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CERTCHAIN_PORT` | 8787 | 监听端口 |
| `CERTCHAIN_HOST` | 127.0.0.1 | 监听地址 |
| `CERTCHAIN_DB` | ./data/certchain.db | SQLite 路径，`:memory:` 为内存库 |
| `CERTCHAIN_RENEWAL_WARNING_DAYS` | 30 | 续期 warning 阈值（天） |
| `CERTCHAIN_RENEWAL_CRITICAL_DAYS` | 7 | 续期 critical 阈值（天） |
| `CERTCHAIN_MAX_CHAIN_LENGTH` | 8 | 最大链长（成环/资源保护） |

## API 与请求样例

```bash
# 装载证书（replace=true 清空后写入；重复 id 返回 409）
curl -X POST http://127.0.0.1:8787/certs -H "content-type: application/json" \
  -d '{"replace": true, "certs": [{"id":"cert-leaf","subject":"service.demo.local","issuer":"Demo Intermediate CA","notBefore":"2026-01-05T00:00:00.000Z","notAfter":"2026-04-15T00:00:00.000Z","keyUsage":["digitalSignature"],"signature":"<64位hex>"}]}'

# 验证目标证书
curl -X POST http://127.0.0.1:8787/validate -H "content-type: application/json" \
  -d '{"targetId": "cert-leaf"}'

# 重放某次验证（含关键中间状态与判断理由）
curl http://127.0.0.1:8787/runs/<runId>
```

签名计算（与 `src/core/hmac.ts` 一致）：
`HMAC_SHA256(key=签发者密钥, id|subject|issuer|notBefore|notAfter|排序后的keyUsage逗号拼接)`，hex 编码。
夹具密钥见 `src/fixtures/caFixtures.ts` 的 `FIXTURE_KEYS`（仅本地演示用途）。

## 验证语义

- 链构建：从目标证书沿 `issuer -> subject` 向上走，直到自签名根。
- 每一级依次检查：有效期 → 自签名位置 → 签名 → 密钥用途 → 上一级存在性。
- 有效期边界：`now < notBefore` 未生效；`now >= notAfter` 已过期（**恰好到期即过期**）。
- 中间证书不能自签名；目标证书自签名直接失败；CA 证书（中间与根）必须含 `keyCertSign`。
- 续期建议按剩余天数分级：`expired` / `critical`(<=7) / `warning`(<=30) / `ok`。

### 链验证失败码（`failure.code`，含 `failure.level` 定位到具体哪一级）

| code | 含义 |
| --- | --- |
| `CHAIN_BREAK` | 上一级签发者证书缺失（或目标证书不在集合中），信任链断裂 |
| `SIGNATURE_INVALID` | 签名与签发者密钥不匹配 |
| `EXPIRED` | 该级证书已过期 |
| `NOT_YET_VALID` | 该级证书尚未生效 |
| `SELF_SIGNED_INTERMEDIATE` | 非根位置（含目标）出现自签名 |
| `MISSING_KEY_USAGE` | CA 证书缺少 keyCertSign 用途 |
| `MISSING_ISSUER_KEY` | 本地密钥库缺少签发者密钥 |
| `CHAIN_TOO_LONG` | 超过最大链长或检测到环路 |

## 错误语义（HTTP 层，四类可区分，绝不把异常统一返回成功）

| category | HTTP | 触发场景 |
| --- | --- | --- |
| `INPUT_ERROR` | 400 | 请求体结构/字段/时间格式/签名格式非法，runId 不存在 |
| `STATE_CONFLICT` | 409 | 证书 id 重复写入 |
| `RESOURCE_EXHAUSTED` | 507 | 单次装载超过 256 张证书 |
| `COMPUTATION_FAILURE` | 500 | 内核执行异常、持久化失败、未知异常 |

错误响应统一为 `{"error": {"category", "message", "detail"}}`。

## 运行日志与重放

每次 `POST /validate` 生成 `runId`（UUID），并把完整结果（逐级状态、失败码、判断理由、
评估时刻）写入 SQLite `runs` 表。通过 `GET /runs/:runId` 可原样重放，`GET /runs` 列出全部运行。

## 复现步骤（从干净目录）

```bash
npm install          # 安装依赖（版本见 package.json / package-lock.json）
npm test             # 独立测试：完整链/断裂定位/恰好过期/续期阈值/签名/自签名等
npm run accept       # 一键验收：4 个场景按固定顺序演练，逐步打印请求/响应/判定
npm run demo         # 可选：查看演示输出
```

`npm run accept` 全部场景通过时退出码为 0；任一场景失败时非 0 退出并打印失败场景名。
