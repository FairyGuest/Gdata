/**
 * One-shot acceptance run: boots the service, executes every required scenario
 * in a fixed order, prints request/response/verdict per step.
 * Exit 0 when all pass, non-zero naming the failed scenario otherwise.
 */
import { buildServer } from "../src/http/server.js";

interface StepResult { scenario: string; ok: boolean; note?: string }
const results: StepResult[] = [];
let current = "";

function scenario(name: string) { current = name; }
function check(label: string, cond: boolean, detail: unknown) {
  const ok = Boolean(cond);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) console.log("       got:", JSON.stringify(detail));
  results.push({ scenario: current, ok, note: label });
}

const { app, engine, store } = buildServer({ host: "127.0.0.1", port: 0, dbPath: ":memory:" });
await app.listen({ host: "127.0.0.1", port: 0 });
const addr = app.server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;
console.log(`acceptance runId=${engine.runId} base=${base}\n`);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  console.log(`  > ${method} ${path} ${body ? JSON.stringify(body) : ""}`);
  console.log(`  < ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json };
}

// --- Scenario 1: registration + first-fit determinism ---
scenario("first-fit determinism");
let r = await call("POST", "/nodes", { id: "n1", capacity: { cpu: 2, memoryMb: 2048 } });
check("node n1 registered", r.status === 200 && r.json.node.id === "n1", r.json);
r = await call("POST", "/nodes", { id: "n2", capacity: { cpu: 8, memoryMb: 8192 } });
check("node n2 registered", r.status === 200, r.json);
r = await call("POST", "/nodes", { id: "n3", capacity: { cpu: 4, memoryMb: 4096 } });
check("node n3 registered", r.status === 200, r.json);
r = await call("POST", "/namespaces", { name: "alpha", quota: { cpu: 16, memoryMb: 16384 } });
check("namespace alpha created (201)", r.status === 201, r.json);

r = await call("POST", "/workloads", { id: "a1", namespace: "alpha", request: { cpu: 1, memoryMb: 1024 } });
check("a1 first-fit -> n1", r.json?.decision?.nodeId === "n1", r.json);
r = await call("POST", "/workloads", { id: "a2", namespace: "alpha", request: { cpu: 3, memoryMb: 1024 } });
check("a2 first-fit -> n2 (n1 cpu full)", r.json?.decision?.nodeId === "n2", r.json);
r = await call("POST", "/workloads", { id: "a3", namespace: "alpha", request: { cpu: 1, memoryMb: 1024 } });
check("a3 first-fit -> n1", r.json?.decision?.nodeId === "n1", r.json);
r = await call("POST", "/workloads", { id: "a4", namespace: "alpha", request: { cpu: 4, memoryMb: 4096 } });
check("a4 first-fit -> n2 (n1 full, n2 has room)", r.json?.decision?.nodeId === "n2", r.json);

// --- Scenario 2: quota-full rejection with shortfall, release, queue drain ---
scenario("quota rejection + release + queue drain");
r = await call("POST", "/namespaces", { name: "beta", quota: { cpu: 2, memoryMb: 2048 } });
check("namespace beta created", r.status === 201, r.json);
r = await call("POST", "/workloads", { id: "b1", namespace: "beta", request: { cpu: 2, memoryMb: 2048 } });
check("b1 placed on n3 (fills beta quota)", r.json?.decision?.nodeId === "n3", r.json);
r = await call("POST", "/workloads", { id: "b2", namespace: "beta", request: { cpu: 1, memoryMb: 512 } });
check("b2 rejected 422 QUOTA_EXCEEDED", r.status === 422 && r.json?.error?.kind === "QUOTA_EXCEEDED", r.json);
check(
  "shortfall cpu=1 memoryMb=512",
  r.json?.error?.details?.shortfall?.cpu === 1 && r.json?.error?.details?.shortfall?.memoryMb === 512,
  r.json,
);
// capacity-blocked but quota-ok -> queued; n2 has 1 cpu free here, g1 needs 4
r = await call("POST", "/namespaces", { name: "gamma", quota: { cpu: 10, memoryMb: 10240 } });
r = await call("POST", "/workloads", { id: "g1", namespace: "gamma", request: { cpu: 4, memoryMb: 4096 } });
check("g1 queued (no node has 4 free cpu right now)", r.status === 202 && r.json?.decision?.outcome === "queued", r.json);
r = await call("DELETE", "/workloads/a2");
check("a2 deleted, releases 3cpu on n2", r.json?.released?.cpu === 3 && r.json?.nodeId === "n2", r.json);
r = await call("GET", "/diag/state");
check("g1 drained FIFO onto n2 after release", r.json?.workloads?.find((w: any) => w.id === "g1")?.nodeId === "n2", r.json);
check("queue empty after drain", (r.json?.queue ?? []).length === 0, r.json);

// --- Scenario 3: namespace cascade eviction ---
scenario("namespace cascade eviction");
r = await call("DELETE", "/namespaces/alpha");
const evicted = (r.json?.evictions ?? []).map((e: any) => e.workloadId).sort();
check("alpha eviction lists a1,a3,a4", JSON.stringify(evicted) === JSON.stringify(["a1", "a3", "a4"]), r.json);
check(
  "each eviction traceable (nodeId+released+reason)",
  (r.json?.evictions ?? []).every((e: any) => e.nodeId && e.released && e.reason === "namespace.deleted"),
  r.json,
);
r = await call("GET", "/diag/state");
check("alpha workloads gone", !(r.json?.workloads ?? []).some((w: any) => w.namespace === "alpha"), r.json);
check("n1 fully released after eviction", r.json?.nodes?.find((n: any) => n.id === "n1")?.used?.cpu === 0, r.json);

// --- Scenario 4: conservation audit ---
scenario("conservation audit");
r = await call("GET", "/diag/audit");
check("audit ok (allocations == node used == namespace used)", r.json?.ok === true, r.json);
r = await call("GET", "/diag/state");
{
  const s = r.json;
  const runSum = (s.workloads ?? []).filter((w: any) => w.status === "running")
    .reduce((a: number, w: any) => a + w.request.cpu, 0);
  const nodeSum = (s.nodes ?? []).reduce((a: number, n: any) => a + n.used.cpu, 0);
  const nsSum = (s.namespaces ?? []).reduce((a: number, n: any) => a + n.used.cpu, 0);
  check(`independent recomputation: ${runSum} == ${nodeSum} == ${nsSum}`, runSum === nodeSum && nodeSum === nsSum, { runSum, nodeSum, nsSum });
}

// --- Scenario 5: error semantics ---
scenario("error semantics");
r = await call("POST", "/namespaces", { name: "beta", quota: { cpu: 1, memoryMb: 1 } });
check("duplicate namespace -> 409 CONFLICT", r.status === 409 && r.json?.error?.kind === "CONFLICT", r.json);
r = await call("POST", "/workloads", { id: "zz", namespace: "ghost", request: { cpu: 1, memoryMb: 1 } });
check("missing namespace -> 404 NOT_FOUND", r.status === 404 && r.json?.error?.kind === "NOT_FOUND", r.json);
r = await call("POST", "/nodes", { id: "bad", capacity: { cpu: -3, memoryMb: 10 } });
check("invalid capacity -> 400 VALIDATION", r.status === 400 && r.json?.error?.kind === "VALIDATION", r.json);
r = await call("DELETE", "/workloads/does-not-exist");
check("unknown workload delete -> 404", r.status === 404, r.json);

// --- Scenario 6: history queryable by namespace and node ---
scenario("sqlite history queries");
r = await call("GET", "/diag/history?namespace=beta");
check("history by namespace beta non-empty", Array.isArray(r.json?.history) && r.json.history.length > 0, r.json);
r = await call("GET", "/diag/history?nodeId=n2");
check("history by node n2 includes placements", (r.json?.history ?? []).some((h: any) => h.action === "workload.placed"), r.json);

await app.close();
store.close();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  const scenarios = [...new Set(failed.map((f) => f.scenario))];
  console.error(`ACCEPTANCE FAILED in scenario(s): ${scenarios.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("ACCEPTANCE PASSED");
}
