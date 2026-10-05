/**
 * One-shot acceptance: runs the unit/integration tests in-process, then boots
 * the service and walks every required scenario in a fixed order, printing
 * request, response and verdict per step. Exit 0 iff everything passes.
 */
import { run } from "node:test";
import { loadConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/server.ts";

let failures = 0;

function verdict(ok: boolean, label: string, reason: string): void {
  console.log("  verdict: " + (ok ? "PASS" : "FAIL") + " - " + label + " (" + reason + ")");
  if (!ok) failures++;
}

async function req(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json() };
}

function show(method: string, path: string, payload: unknown, result: { status: number; body: any }): void {
  console.log("  request : " + method + " " + path + (payload !== undefined ? " body=" + JSON.stringify(payload) : ""));
  console.log("  response: " + result.status + " " + JSON.stringify(result.body).slice(0, 400));
}

const SCHEMA = {
  fields: {
    name: { type: "string", minLength: 3, maxLength: 8 },
    age: { type: "integer", min: 18, max: 65 },
    role: { type: "enum", values: ["admin", "user", "guest"] },
    hired: { type: "date", min: "2020-01-01", max: "2024-12-31" },
    tags: { type: "array", items: { type: "integer", min: 0, max: 9 }, minItems: 1, maxItems: 3 },
    address: { type: "object", properties: { zip: { type: "string", minLength: 5, maxLength: 5 } } },
  },
};

console.log("== step 0: unit & integration tests (node:test, in-process) ==");
const testStream = run({
  isolation: "none",
  files: ["tests/schema.test.ts", "tests/generator.test.ts", "tests/api.test.ts"],
});
let testsFailed = 0;
let testsPassed = 0;
for await (const event of testStream) {
  if (event.type === "test:pass") { testsPassed++; console.log("  ok   - " + event.data.name); }
  if (event.type === "test:fail") { testsFailed++; console.log("  FAIL - " + event.data.name + ": " + event.data.details.error.message); }
}
verdict(testsFailed === 0 && testsPassed > 0, "test suite", testsPassed + " passed, " + testsFailed + " failed");
if (testsFailed > 0 || testsPassed === 0) {
  console.log("aborting acceptance: test suite failed");
  process.exit(1);
}

let server: RunningServer | null = null;
try {
  server = await startServer(loadConfig({ port: 0, dbPath: ":memory:" }));
  const base = "http://127.0.0.1:" + server.port;
  console.log("\nserver up on " + base + " (adapter: " + server.adapter + ")");

  console.log("\n== step 1: health ==");
  const health = await req(base, "GET", "/health");
  show("GET", "/health", undefined, health);
  verdict(health.status === 200 && health.body.status === "ok", "health", "status=" + health.status);

  console.log("\n== step 2: same seed twice -> identical output ==");
  const payload = { seed: 2024, count: 8, schema: SCHEMA };
  const a = await req(base, "POST", "/generate", payload);
  const b = await req(base, "POST", "/generate", payload);
  show("POST", "/generate", payload, a);
  show("POST", "/generate", payload, b);
  verdict(
    a.status === 200 && b.status === 200 && JSON.stringify(a.body.rows) === JSON.stringify(b.body.rows),
    "reproducibility",
    "two runs with seed=2024 compared byte-for-byte",
  );

  console.log("\n== step 3: per-type constraint validation ==");
  const rows = a.body.rows as any[];
  let constraintsOk = rows.length === 8;
  for (const row of rows) {
    constraintsOk &&= typeof row.name === "string" && row.name.length >= 3 && row.name.length <= 8;
    constraintsOk &&= Number.isInteger(row.age) && row.age >= 18 && row.age <= 65;
    constraintsOk &&= ["admin", "user", "guest"].includes(row.role);
    constraintsOk &&= typeof row.hired === "string" && row.hired >= "2020-01-01" && row.hired <= "2024-12-31";
    constraintsOk &&= Array.isArray(row.tags) && row.tags.length >= 1 && row.tags.length <= 3
      && row.tags.every((t: number) => Number.isInteger(t) && t >= 0 && t <= 9);
    constraintsOk &&= typeof row.address?.zip === "string" && row.address.zip.length === 5;
  }
  verdict(constraintsOk, "constraints", "all 8 rows checked against every field constraint");

  console.log("\n== step 4: nested structure recursion ==");
  const nested = await req(base, "POST", "/generate", {
    seed: 9, count: 3,
    schema: { fields: { node: { type: "object", properties: { leaf: { type: "object", properties: { v: { type: "integer", min: 1, max: 1 } } } } } } },
  });
  show("POST", "/generate", { seed: 9, count: 3, schema: "nested 3-level object" }, nested);
  verdict(
    nested.status === 200 && (nested.body.rows as any[]).every((r) => r.node?.leaf?.v === 1),
    "nested recursion",
    "3-level nested object generated, innermost integer pinned to 1",
  );

  console.log("\n== step 5: constraint conflict -> 422 CONSTRAINT_CONFLICT ==");
  const conflict = await req(base, "POST", "/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "integer", min: 10, max: 2 } } } });
  show("POST", "/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "integer", min: 10, max: 2 } } } }, conflict);
  verdict(
    conflict.status === 422 && conflict.body.error?.code === "CONSTRAINT_CONFLICT",
    "conflict error semantics",
    "status=" + conflict.status + " code=" + conflict.body.error?.code,
  );

  console.log("\n== step 6: invalid input -> 400 SCHEMA_VALIDATION ==");
  const invalid = await req(base, "POST", "/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "wat" } } } });
  show("POST", "/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "wat" } } } }, invalid);
  verdict(
    invalid.status === 400 && invalid.body.error?.code === "SCHEMA_VALIDATION",
    "validation error semantics",
    "status=" + invalid.status + " code=" + invalid.body.error?.code,
  );

  console.log("\n== step 7: save dataset + verify reproducibility from seed ==");
  const save = await req(base, "POST", "/datasets", { id: "accept-ds", seed: 555, count: 6, schema: SCHEMA });
  show("POST", "/datasets", { id: "accept-ds", seed: 555, count: 6, schema: "SCHEMA" }, save);
  const verify = await req(base, "POST", "/datasets/accept-ds/verify");
  show("POST", "/datasets/accept-ds/verify", undefined, verify);
  verdict(
    save.status === 201 && verify.status === 200 && verify.body.match === true,
    "save + verify",
    "dataset regenerated from seed=555 matches stored rows",
  );

  console.log("\n== step 8: state conflict -> 409 STATE_CONFLICT ==");
  const dup = await req(base, "POST", "/datasets", { id: "accept-ds", seed: 1, count: 1, schema: SCHEMA });
  show("POST", "/datasets", { id: "accept-ds (duplicate)" }, dup);
  verdict(
    dup.status === 409 && dup.body.error?.code === "STATE_CONFLICT",
    "state conflict semantics",
    "status=" + dup.status + " code=" + dup.body.error?.code,
  );

  console.log("\n== step 9: resource exhaustion -> 413 RESOURCE_EXHAUSTED ==");
  const big = await req(base, "POST", "/generate", { seed: 1, count: 100001, schema: SCHEMA });
  show("POST", "/generate", { seed: 1, count: 100001, schema: "SCHEMA" }, big);
  verdict(
    big.status === 413 && big.body.error?.code === "RESOURCE_EXHAUSTED",
    "resource exhaustion semantics",
    "status=" + big.status + " code=" + big.body.error?.code,
  );

  console.log("\n== step 10: diagnostics logs carry runId ==");
  const runId = a.body.runId as string;
  const logs = await req(base, "GET", "/diagnostics/logs?runId=" + runId);
  show("GET", "/diagnostics/logs?runId=" + runId, undefined, logs);
  verdict(
    logs.status === 200 && Array.isArray(logs.body.logs) && logs.body.logs.length >= 2
      && logs.body.logs.every((e: any) => e.runId === runId),
    "diagnostics",
    (logs.body.logs?.length ?? 0) + " log entries replay run " + runId,
  );
} finally {
  if (server) await server.close();
}

console.log("\n== acceptance result: " + (failures === 0 ? "ALL SCENARIOS PASSED" : failures + " scenario(s) FAILED") + " ==");
process.exitCode = failures === 0 ? 0 : 1;

