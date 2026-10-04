
# API 密钥配额管理服务

密钥绑定到三级层级作用域（global -> org -> project），配额消耗时三层在同一事务内原子扣减，任一层不足即整体拒绝并回滚；支持密钥轮换（旧密钥宽限期）与按密钥查询用量。时间通过注入的 Clock 抽象控制（测试用 VirtualClock）。

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22.18（开发用 24.14） | 运行时；node:sqlite 内置 SQLite，直接运行 TS（type stripping） |
| fastify | ^5.12.5 | HTTP 层 |
| typescript | ^5.9.3（dev） | 类型检查 npm run typecheck |
| @types/node | ^22.20.4（dev） | 类型定义 |

无其他运行时依赖；SQLite 使用 Node 内置 node:sqlite，无需原生编译。所有数据均为本地合成夹具（内存库或本地文件库），不需要任何生产账号或真实业务数据。

## 目录结构（工程边界）

    src/
      config.ts             配置层：环境变量解析，默认值，便于测试注入
      index.ts              服务入口：装配各层并启动 HTTP
      domain/
        types.ts            数据契约：Scope/ApiKey/UsageEvent/ConsumeResult/UsageReport
        errors.ts           错误契约：AppError + 稳定错误码 + HTTP 状态映射
        clock.ts            时间抽象：Clock / SystemClock / VirtualClock
        logger.ts           诊断日志：runId/requestId/中间状态/判断理由，环形缓冲
      store/sqliteStore.ts  状态适配层：SQLite 持久化，consumeAtomic 单事务三层扣减
      service/quotaService.ts 执行内核：扣减、轮换、宽限扫描、用量报告
      http/server.ts        契约解析层：Fastify 路由，参数校验与错误码映射
    tests/quota.test.ts     独立行为测试（node:test，断言具体结果与失败类别）
    scripts/demo.ts         本地演示：内存库 + 虚拟时钟跑通全链路
    scripts/accept.ts       一键验收：进程内起真实 HTTP 服务，固定顺序演练全部场景

## 快速开始（从干净目录复现）

    npm install        # 安装 fastify / typescript / @types/node（package-lock.json 锁定版本）
    npm run typecheck  # 类型检查
    npm test           # 独立测试：8 个用例，断言具体余额、错误码与失败类别
    npm run demo       # 本地演示：建层级 -> 发钥 -> 扣减 -> 超限 -> 轮换 -> 过期 -> 日志重放
    npm run accept     # 一键验收：7 组场景 20 项判定，全部通过退出 0，任一失败非 0 并列出失败场景
    npm start          # 启动服务（默认 127.0.0.1:8787，内存库）

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| PORT / HOST | 8787 / 127.0.0.1 | 监听地址 |
| DB_PATH | :memory: | SQLite 路径，传文件路径即持久化 |
| CLOCK | system | virtual 时使用 VirtualClock（测试用） |
| GRACE_PERIOD_MS | 60000 | 轮换后旧密钥宽限期（毫秒） |
| LOG_CAPACITY | 1000 | 诊断日志环形缓冲容量 |

## API 与请求样例

密钥通过 x-api-key 头（或 Authorization: Bearer）传递。

    # 建层级：global -> org -> project（父级层级不符返回 400 INVALID_REQUEST）
    curl -X POST localhost:8787/scopes -H 'content-type: application/json' -d '{"id":"g","level":"global","quotaLimit":100}'
    curl -X POST localhost:8787/scopes -H 'content-type: application/json' -d '{"id":"o","level":"org","parentId":"g","quotaLimit":50}'
    curl -X POST localhost:8787/scopes -H 'content-type: application/json' -d '{"id":"p","level":"project","parentId":"o","quotaLimit":5}'

    # 发钥（绑定 project 作用域）
    curl -X POST localhost:8787/keys -H 'content-type: application/json' -d '{"projectScopeId":"p"}'
    # -> {"id":"key_...","secret":"sk_...","status":"active",...}

    # 消耗配额：三层同事务扣减，响应携带各层余额
    curl -X POST localhost:8787/consume -H 'x-api-key: sk_...' -H 'content-type: application/json' -d '{"amount":3}'

    # 按密钥查询用量（事件流 + 各层余额）
    curl localhost:8787/usage -H 'x-api-key: sk_...'

    # 轮换：旧钥进入宽限期，宽限内仍可用，过期后 403 KEY_EXPIRED
    curl -X POST localhost:8787/keys/rotate -H 'x-api-key: sk_...'

    # 诊断：运行日志（可重放）与健康检查
    curl 'localhost:8787/logs?limit=100'
    curl localhost:8787/health

## 错误语义

所有可预期失败返回稳定 code，HTTP 状态码由错误码映射；未知异常一律 500 INTERNAL，不会统一包装成成功。

| code | HTTP | 类别 | 含义 |
| --- | --- | --- | --- |
| INVALID_REQUEST | 400 | 输入错误 | 参数非法（amount 非正整数、层级父子关系不符等） |
| KEY_UNKNOWN | 401 | 输入错误 | 密钥不存在或缺失 |
| KEY_EXPIRED | 403 | 状态冲突 | 密钥已过宽限期（含过期密钥再轮换） |
| QUOTA_EXCEEDED | 409 | 资源耗尽 | 某一层额度不足，details 指明 level/scopeId/limit/used/remaining/requested |
| NOT_FOUND | 404 | 输入错误 | 引用的作用域不存在 |
| CONFLICT | 409 | 状态冲突 | 唯一性冲突或重复轮换（id/secret 已存在、密钥已轮换过） |
| INTERNAL | 500 | 计算失败 | 未预期异常 |

## 正确性保证与验证方式

- 三层原子扣减：consumeAtomic 在 BEGIN IMMEDIATE 事务内对 project -> org -> global 逐层执行带守卫条件的 UPDATE ... WHERE quota_used + amount <= quota_limit；任一层不满足即 ROLLBACK，不存在只扣了项目层的中间态。
- 并发不丢更新：守卫条件在 SQL 内求值而非先读后写，并发消耗同一密钥不会超扣也不会丢失更新。验收场景 [4] 用 25 并发抢 10 额度，断言恰好 10 成功 / 15 拒绝且三层余额均为 10（守恒）。
- 轮换宽限边界：轮换后旧钥状态为 grace 并记录 graceUntil = now + GRACE_PERIOD_MS；宽限内旧钥正常扣减，超过后返回 KEY_EXPIRED（消费时惰性判定 + 后台 sweep 双保险）。测试用 VirtualClock 精确推进时间验证边界。
- 日志可重放：每次状态变更写入 {seq, runId, requestId, event, state, reason}，包含扣减前后各层余额、拒绝理由、轮换截止时刻等关键中间状态，GET /logs 可拉取重放。

## 验收脚本判定项（npm run accept，固定顺序）

1. 层级建模与契约校验（非法父子关系 400）
2. 发钥 + 三层联动扣减（三层 used 一致）
3. 超限 409 + 回滚（拒绝后各层余额不变）
4. 并发消耗余额守恒（25 并发 / 10 成功 / 15 拒绝 / 三层均为 10）
5. 轮换宽限边界（宽限内可用、过期 403、新钥可用）
6. 错误类别可区分（缺钥 401、非法 amount 400）
7. 诊断日志包含 consume/reject/rotate/expire 事件

全部通过退出码 0；任一失败退出码 1 并打印失败场景名。

## 本次验收实测结果

- npm run typecheck：通过
- npm test：8 passed, 0 failed
- npm run accept：20 passed, 0 failed，退出码 0
- npm run demo：全链路输出正常（超限拒绝、宽限过期 sweep、用量报告、日志重放）

