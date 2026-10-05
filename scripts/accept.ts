// 一键验收：固定顺序演练全部场景，逐步打印请求/响应/判定。
// 全部通过退出 0；任一场景失败打印场景名并非 0 退出。

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const config = { ...loadConfig(), port: 8799, dbPath: ":memory:", maxCasesPerReport: 50 };
const { app } = buildApp(config);
const server = await app.listen(config.port, config.host);
const base = `http://${config.host}:${config.port}`;

let failures = 0;

async function step(
  title: string,
  method: string,
  path: string,
  body: unknown,
  expect: (status: number, json: any) => string | null, // 返回 null 通过，否则失败原因
) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`\n=== ${title}`);
  console.log(`>> ${method} ${path}`);
  if (body !== undefined) console.log(`>> body: ${JSON.stringify(body).slice(0, 200)}`);
  console.log(`<< ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const why = expect(res.status, json);
  if (why) {
    failures++;
    console.log(`[FAIL] ${title}: ${why}`);
  } else {
    console.log(`[PASS] ${title}`);
  }
}

// 1. 健康检查
await step("S1 健康检查", "GET", "/health", undefined, (s, j) =>
  s === 200 && j.status === "ok" ? null : "health not ok",
);

// 2. 纯通过报告
await step(
  "S2 纯通过聚合",
  "POST",
  "/api/reports",
  {
    reportId: "acc-pass",
    runs: [
      {
        runId: "acc-run-p1",
        cases: [
          { file: "a.spec.ts", name: "t1", status: "passed", durationMs: 10 },
          { file: "a.spec.ts", name: "t2", status: "ok", durationMs: 20 },
        ],
      },
    ],
  },
  (s, j) =>
    s === 201 && j.summary.total === 2 && j.summary.passed === 2 && j.summary.failed === 0
      ? null
      : `bad summary ${JSON.stringify(j.summary)}`,
);

// 3. 纯失败报告
await step(
  "S3 纯失败聚合",
  "POST",
  "/api/reports",
  {
    reportId: "acc-fail",
    runs: [
      {
        runId: "acc-run-f1",
        cases: [
          { file: "b.spec.ts", name: "t1", status: "failed", durationMs: 5 },
          { file: "b.spec.ts", name: "t2", status: "error", durationMs: 7 },
        ],
      },
    ],
  },
  (s, j) =>
    s === 201 && j.summary.failed === 2 && j.summary.passed === 0
      ? null
      : `bad summary ${JSON.stringify(j.summary)}`,
);

// 4. 混合状态基线报告
await step(
  "S4 混合状态聚合(基线)",
  "POST",
  "/api/reports",
  {
    reportId: "acc-base",
    runs: [
      {
        runId: "acc-run-m1",
        cases: [
          { file: "m.spec.ts", name: "will-break", status: "passed", durationMs: 10 },
          { file: "m.spec.ts", name: "stays-bad", status: "failed", durationMs: 20 },
          { file: "m.spec.ts", name: "will-heal", status: "failed", durationMs: 30 },
          { file: "m.spec.ts", name: "quiet", status: "skipped", durationMs: 0 },
        ],
      },
    ],
  },
  (s, j) =>
    s === 201 && j.summary.total === 4 && j.summary.failed === 2 && j.summary.skipped === 1
      ? null
      : `bad summary ${JSON.stringify(j.summary)}`,
);

// 5. 第二次报告（状态变化）
await step(
  "S5 混合状态聚合(目标)",
  "POST",
  "/api/reports",
  {
    reportId: "acc-target",
    runs: [
      {
        runId: "acc-run-m2",
        cases: [
          { file: "m.spec.ts", name: "will-break", status: "failed", durationMs: 11 },
          { file: "m.spec.ts", name: "stays-bad", status: "failed", durationMs: 21 },
          { file: "m.spec.ts", name: "will-heal", status: "passed", durationMs: 31 },
          { file: "m.spec.ts", name: "quiet", status: "skipped", durationMs: 0 },
        ],
      },
    ],
  },
  (s, j) => (s === 201 && j.summary.failed === 2 ? null : `bad summary ${JSON.stringify(j.summary)}`),
);

// 6. 过滤与排序
await step("S6 过滤+排序", "GET", "/api/reports/acc-target?status=failed&sortBy=durationMs&order=desc", undefined, (s, j) => {
  if (s !== 200) return "status != 200";
  const names = j.cases.map((c: any) => c.name);
  return JSON.stringify(names) === JSON.stringify(["stays-bad", "will-break"])
    ? null
    : `unexpected ${JSON.stringify(names)}`;
});

// 7. 对比：分类与顺序
await step("S7 报告对比", "GET", "/api/reports/acc-base/diff/acc-target", undefined, (s, j) => {
  if (s !== 200) return "status != 200";
  const seq = j.entries.map((e: any) => e.name + ":" + e.category);
  const expected = ["will-break:new_failure", "stays-bad:persistent_failure", "will-heal:recovered", "quiet:passed"];
  return JSON.stringify(seq) === JSON.stringify(expected)
    ? null
    : `unexpected ${JSON.stringify(seq)}`;
});

// 8. 非法输入 -> INPUT_ERROR
await step("S8 非法输入", "POST", "/api/reports", { runs: [{ runId: "x", cases: [{ file: "a", name: "t", status: "passed", durationMs: -3 }] }] }, (s, j) =>
  s === 400 && j.error.code === "INPUT_ERROR" ? null : `got ${s} ${j.error?.code}`,
);

// 9. 未知状态 -> UNKNOWN_STATUS
await step("S9 未知状态", "POST", "/api/reports", { runs: [{ runId: "x", cases: [{ file: "a", name: "t", status: "maybe", durationMs: 1 }] }] }, (s, j) =>
  s === 422 && j.error.code === "UNKNOWN_STATUS" ? null : `got ${s} ${j.error?.code}`,
);

// 10. 状态冲突 -> STATUS_CONFLICT
await step(
  "S10 状态冲突",
  "POST",
  "/api/reports",
  {
    runs: [
      { runId: "c1", cases: [{ file: "a", name: "t", status: "passed", durationMs: 1 }] },
      { runId: "c2", cases: [{ file: "a", name: "t", status: "failed", durationMs: 1 }] },
    ],
  },
  (s, j) => (s === 409 && j.error.code === "STATUS_CONFLICT" ? null : `got ${s} ${j.error?.code}`),
);

// 11. 资源耗尽 -> RESOURCE_EXHAUSTED（上限 50，发 60 条）
await step(
  "S11 资源耗尽",
  "POST",
  "/api/reports",
  {
    runs: [
      {
        runId: "big",
        cases: Array.from({ length: 60 }, (_, i) => ({ file: "f", name: "t" + i, status: "passed", durationMs: 1 })),
      },
    ],
  },
  (s, j) => (s === 413 && j.error.code === "RESOURCE_EXHAUSTED" ? null : `got ${s} ${j.error?.code}`),
);

// 12. 报告不存在 -> NOT_FOUND
await step("S12 报告不存在", "GET", "/api/reports/no-such-report", undefined, (s, j) =>
  s === 404 && j.error.code === "NOT_FOUND" ? null : `got ${s} ${j.error?.code}`,
);

// 13. 诊断接口：错误目录与日志可重放
await step("S13 诊断接口", "GET", "/api/diagnostics/logs", undefined, (s, j) => {
  if (s !== 200 || !Array.isArray(j.logs)) return "no logs";
  const hasRunId = j.logs.some((l: any) => l.runId === "acc-run-m2");
  const hasReason = j.logs.every((l: any) => typeof l.reason === "string");
  return hasRunId && hasReason ? null : "logs lack runId/reason";
});

server.close();
console.log(`\n========== ACCEPTANCE ${failures === 0 ? "PASSED" : "FAILED: " + failures + " scenario(s)"} ==========`);
process.exitCode = failures === 0 ? 0 : 1;


