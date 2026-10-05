// 本地演示：进程内启动服务，演练聚合 -> 过滤 -> 对比全流程。

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const config = { ...loadConfig(), port: 8791, dbPath: ":memory:" };
const { app } = buildApp(config);
const server = await app.listen(config.port, config.host);
const base = `http://${config.host}:${config.port}`;

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function get(path: string) {
  return (await fetch(base + path)).json();
}

const r1 = await post("/api/reports", {
  reportId: "nightly-001",
  runs: [
    {
      runId: "run-101",
      cases: [
        { file: "auth.spec.ts", name: "login ok", status: "passed", durationMs: 120 },
        { file: "auth.spec.ts", name: "login bad pwd", status: "failed", durationMs: 98 },
        { file: "cart.spec.ts", name: "add item", status: "passed", durationMs: 45 },
      ],
    },
    {
      runId: "run-102",
      cases: [{ file: "cart.spec.ts", name: "checkout", status: "skipped", durationMs: 0 }],
    },
  ],
});
console.log("report1 summary:", r1.summary);

const r2 = await post("/api/reports", {
  reportId: "nightly-002",
  runs: [
    {
      runId: "run-201",
      cases: [
        { file: "auth.spec.ts", name: "login ok", status: "passed", durationMs: 110 },
        { file: "auth.spec.ts", name: "login bad pwd", status: "passed", durationMs: 95 },
        { file: "cart.spec.ts", name: "add item", status: "failed", durationMs: 60 },
        { file: "cart.spec.ts", name: "checkout", status: "skipped", durationMs: 0 },
      ],
    },
  ],
});
console.log("report2 summary:", r2.summary);

console.log("failed only:", (await get("/api/reports/nightly-002?status=failed")).cases.map((c: any) => c.name));
console.log("slowest first:", (await get("/api/reports/nightly-002?sortBy=durationMs&order=desc")).cases.map((c: any) => c.name));

const diff = await get("/api/reports/nightly-001/diff/nightly-002");
console.log("diff summary:", diff.summary);
console.log("diff order:", diff.entries.map((e: any) => `${e.name}:${e.category}`));

server.close();

