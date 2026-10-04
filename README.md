# cert-chain-a

证书链验证服务：给定一组证书（主题、签发者、有效期、密钥用途、HMAC-SHA256 模拟签名），
验证目标证书到根证书的完整信任链，检查链上每张证书的有效期，并按剩余有效期给出续期建议。
所有数据均为本地合成夹具，无需任何生产账号或真实业务数据。

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 22.5（开发于 v24.14.1） | 运行时，内置 `node:sqlite` 提供 SQLite |
| fastify | 5.12.5 | HTTP 服务 |
| typescript | 5.9.3 | 编译（dev） |
| @types/node | 22.20.4 | 类型（dev） |

无其他运行时依赖；SQLite 使用 Node 内置 `node:sqlite`（DatabaseSync）。

## 快速开始（干净目录复现）

```powershell
npm install        # 安装上述依赖（package-lock.json 已固定版本）
npm run accept     # 一键验收：编译 + 单元测试 + 5 个场景演练，全过退出 0
npm start          # 启动服务，默认 http://127.0.0.1:8787
npm run demo       # 本地演示：起服务、提交有效链与被篡改链、回放诊断记录
npm test           # 仅编译并运行测试（node:test，进程内执行）
```

`npm run accept` 按固定顺序演练并逐场景打印请求/响应/判定：
S1 完整链通过并回放诊断记录；S2 断链定位到具体级别；S3 恰好在评估时刻过期判 CERT_EXPIRED；
S4 续期阈值（30 天=RENEW_SOON，7 天=RENEW_IMMEDIATELY，31 天=NONE）；S5 非法输入判 INPUT_INVALID。
任一场景失败则以非 0 退出并指出失败场景。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CERTCHAIN_PORT` / `CERTCHAIN_HOST` | 8787 / 127.0.0.1 | 监听地址 |
| `CERTCHAIN_MASTER_SECRET` | local-dev-master-secret | 模拟 CA 主密钥（仅本地） |
| `CERTCHAIN_TRUSTED_ROOTS` | CN=Demo Root CA | 信任的根主题，逗号分隔 |
| `CERTCHAIN_RENEW_SOON_DAYS` | 30 | 剩余有效期 <= 该值建议 RENEW_SOON |
| `CERTCHAIN_RENEW_IMMEDIATELY_DAYS` | 7 | <= 该值建议 RENEW_IMMEDIATELY |
| `CERTCHAIN_MAX_CHAIN_LENGTH` | 8 | 链长资源上限，超出报 CHAIN_TOO_LONG |
| `CERTCHAIN_DB_PATH` | certchain.db | SQLite 文件，`:memory:` 为纯内存 |

## 签名模型（模拟）

CA 密钥由主密钥派生：`key(issuer) = HMAC_SHA256(masterSecret, "ca-key:" + issuer)`。
证书签名 = 以签发者密钥对规范载荷
`serial|subject|issuer|notBefore|notAfter|sorted(keyUsage)` 做 HMAC-SHA256（hex）。
验证方只需主密钥即可校验每一级签名；时间由注入的 `VirtualClock` 提供
（服务用 SystemClock，测试/验收用 FixedClock）。

## API

### POST /v1/verify

请求体：`{ "chain": [leaf, intermediate, ..., root] }`（叶子在前、根在最后）。
证书字段：`serial, subject, issuer, notBefore, notAfter, keyUsage[], signature`（ISO-8601 时间）。

成功（200）：

```json
{
  "ok": true,
  "runId": "1e25e621-b31d-4510-ad19-314749670b0f",
  "evaluatedAt": "2026-06-15T00:00:00.000Z",
  "chainLength": 3,
  "links": [ { "index": 0, "subject": "CN=service.local", "signatureValid": true,
               "inValidityWindow": true, "remainingDays": 90, "renewalAction": "NONE", "problems": [] } ],
  "renewalAdvice": [ { "serial": "leaf-1", "subject": "CN=service.local", "remainingDays": 90, "action": "NONE" } ]
}
```

失败（4xx，示例断链）：

```json
{
  "ok": false,
  "runId": "...",
  "code": "CHAIN_LINK_MISMATCH",
  "message": "link 0: issuer \"CN=Rogue CA\" does not match subject \"CN=Demo Intermediate CA\" of link 1",
  "linkIndex": 0,
  "links": []
}
```

### GET /v1/runs/:runId （诊断接口）

返回该次验证的完整结果与逐级检查轨迹（`steps[]`：级别、主题、检查项、结果、理由），
凭 runId 即可重放问题。未知 runId 返回 404。

### GET /health

`{ "status": "ok", "now": "..." }`

## 错误语义

有效期窗口为左闭右开 `[notBefore, notAfter)`：到达 notAfter 那一刻即视为过期。
每个失败都带 `linkIndex`（0=叶子）定位出错级别；输入级错误 `linkIndex` 为 null。

| code | HTTP | 含义 |
|---|---|---|
| INPUT_INVALID | 400 | 请求体/证书字段不符合契约 |
| CHAIN_LINK_MISMATCH | 422 | 第 N 级 issuer 与第 N+1 级 subject 不匹配 |
| SIGNATURE_INVALID | 422 | 该级 HMAC 签名验签失败 |
| INTERMEDIATE_SELF_SIGNED | 422 | 中间证书自签名（禁止） |
| ROOT_NOT_SELF_SIGNED | 422 | 根证书非自签名 |
| ROOT_UNTRUSTED | 422 | 根不在信任库 |
| CERT_EXPIRED | 422 | 该级已过期（now >= notAfter） |
| CERT_NOT_YET_VALID | 422 | 该级尚未生效 |
| CHAIN_TOO_LONG | 413 | 链长超资源上限 |
| STATE_CONFLICT | 409 | 状态层冲突（如 runId 重复） |
| STATE_UNAVAILABLE | 503 | 状态层不可用 |
| INTERNAL_ERROR | 500 | 未预期错误 |

任何异常或未知状态都不会被吞成成功：核心返回判别联合 `VerifyResult`，
HTTP 层按上表映射状态码，持久化失败会以 STATE_* 错误显式返回。

## 续期建议

按评估时刻剩余天数（向下取整）：`> renewSoonDays` → NONE；
`<= renewSoonDays` → RENEW_SOON；`<= renewImmediatelyDays` 或已过期 → RENEW_IMMEDIATELY。

## 工程结构

```
src/
  config.ts            配置层（环境变量 -> ServiceConfig）
  domain/types.ts      数据与错误契约（Certificate / VerifyResult / FailureCode）
  domain/clock.ts      VirtualClock 抽象（System/Fixed/Mutable）
  domain/signing.ts    HMAC-SHA256 模拟 CA 签名与验签
  core/verifyChain.ts  执行内核：纯函数链验证（契约解析 -> 自签规则 -> 链接 -> 签名 -> 有效期）
  core/renewal.ts      续期策略
  state/runStore.ts    状态适配：SQLite 持久化运行记录与逐级轨迹
  fixtures/ca.ts       本地合成 CA 夹具（root/intermediate/leaf）
  http/server.ts       Fastify 装配与错误映射
  index.ts             服务入口
tests/                 独立测试（期望值手写/独立计算，非由被测核心生成）
scripts/accept.ts      一键验收（npm run accept）
scripts/demo.ts        本地演示
```

## 测试

16 个用例（`npm test`，编译后进程内执行 node:test）覆盖：完整链通过、断链定位、
签名篡改、恰好过期边界（含过期前 1ms 仍通过）、续期阈值三档、中间证书自签、
根不受信、尚未生效、链长超限、非法输入、API 契约、诊断回放、签名夹具确定性。
测试断言具体结果与失败类别（code + linkIndex），而非仅检查接口可调。

