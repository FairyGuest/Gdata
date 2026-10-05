// One-shot acceptance script: runs all scenarios in a fixed order against a
// freshly booted service (in-memory DB), prints request/response/verdict for
// each step, exits 0 only if every scenario passes.
import { buildApp } from "../src/server/app.ts";
import assert from "node:assert/strict";

interface Step {
  name: string;
  run: (ctx: { post: (p: string, b: unknown) => Promise<{ status: number; body: any }>; get: (p: string) => Promise<{ status: number; body: any }> }) => Promise<void>;
}

const app = await buildApp({ port: 0, dbPath: ":memory:", logFile: undefined });
await app.adapter.listen(0, "127.0.0.1");
const base = "http://127.0.0.1:" + app.adapter.port();

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function get(path: string) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

function scheduleExit(code: number): void {
  setTimeout(() => process.exit(code), 100);
}

const steps: Step[] = [
  {
    name: "S1 first call auto-creates snapshot",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b"], meta: { ts: 1 } } });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "created");
    },
  },
  {
    name: "S2 identical call passes",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b"], meta: { ts: 1 } } });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.body.status, "passed");
      assert.deepEqual(r.body.diffs, []);
    },
  },
  {
    name: "S3 nested field diff located at exact path",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Shanghai" } }, tags: ["a", "b"], meta: { ts: 1 } } });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.body.status, "failed");
      assert.deepEqual(r.body.diffs, [
        { path: "user.address.city", type: "modified", before: "Beijing", after: "Shanghai" },
      ]);
    },
  },
  {
    name: "S4 array element add/remove detected",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b", "c"], meta: { ts: 1 } } });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.body.status, "failed");
      assert.deepEqual(r.body.diffs, [{ path: "tags[2]", type: "added", after: "c" }]);
      const r2 = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Beijing" } }, tags: ["a"], meta: { ts: 1 } } });
      console.log("  response: HTTP " + r2.status + " " + JSON.stringify(r2.body));
      assert.deepEqual(r2.body.diffs, [{ path: "tags[1]", type: "removed", before: "b" }]);
    },
  },
  {
    name: "S5 ignored field paths suppress diffs",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b"], meta: { ts: 999999 } }, ignorePaths: ["meta.ts"] });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.body.status, "passed");
    },
  },
  {
    name: "S6 force update overwrites snapshot",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { name: "acc-user", data: { v: "new" }, update: true });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.body.status, "updated");
      const r2 = await post("/snapshots/compare", { name: "acc-user", data: { v: "new" } });
      console.log("  response: HTTP " + r2.status + " " + JSON.stringify(r2.body));
      assert.equal(r2.body.status, "passed");
    },
  },
  {
    name: "S7 input error is categorized (INPUT_ERROR/400)",
    run: async ({ post }) => {
      const r = await post("/snapshots/compare", { data: 1 });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.status, 400);
      assert.equal(r.body.error.category, "INPUT_ERROR");
      assert.equal(r.body.error.code, "INVALID_NAME");
    },
  },
  {
    name: "S8 state conflict is categorized (STATE_CONFLICT/409)",
    run: async ({ post }) => {
      await post("/snapshots/create", { name: "acc-dup", data: 1 });
      const r = await post("/snapshots/create", { name: "acc-dup", data: 2 });
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.status, 409);
      assert.equal(r.body.error.category, "STATE_CONFLICT");
      assert.equal(r.body.error.code, "SNAPSHOT_EXISTS");
    },
  },
  {
    name: "S9 resource exhaustion is categorized (RESOURCE_EXHAUSTED/507)",
    run: async ({ post }) => {
      const big = "x".repeat(2 * 1024 * 1024);
      const res = await fetch(base + "/snapshots/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "big", data: big }) });
      const body = await res.json();
      console.log("  response: HTTP " + res.status + " " + JSON.stringify(body));
      assert.equal(res.status, 507);
      assert.equal(body.error.category, "RESOURCE_EXHAUSTED");
      assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
    },
  },
  {
    name: "S10 missing snapshot lookup is STATE_CONFLICT/404-style conflict",
    run: async ({ get }) => {
      const r = await get("/snapshots/never-created");
      console.log("  response: HTTP " + r.status + " " + JSON.stringify(r.body));
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "SNAPSHOT_NOT_FOUND");
    },
  },
];

console.log("acceptance: service booted with adapter=" + app.adapter.kind + " at " + base + "\n");
let failed = 0;
for (const step of steps) {
  console.log("[RUN ] " + step.name);
  try {
    await step.run({ post, get });
    console.log("[PASS] " + step.name + "\n");
  } catch (e) {
    failed++;
    console.log("[FAIL] " + step.name);
    console.log("  reason: " + (e instanceof Error ? e.message : String(e)) + "\n");
  }
}
await app.close();
if (failed > 0) {
  console.log("acceptance FAILED: " + failed + " scenario(s) failed");
  scheduleExit(1);
}
console.log("acceptance OK: all " + steps.length + " scenarios passed");
scheduleExit(0);

