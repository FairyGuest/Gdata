// One-shot acceptance script: boots the real service entry on an ephemeral
// port with a temp database, then drills every required scenario in a fixed
// order. Prints request / response / verdict per step. Exit 0 iff all pass.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8791;
const BASE = "http://127.0.0.1:" + PORT;
const tmpDir = mkdtempSync(join(tmpdir(), "snapshot-accept-"));

let child: ChildProcess | null = null;
let failures = 0;
let step = 0;

function print(obj: unknown): string {
  return JSON.stringify(obj);
}

async function request(method: string, path: string, body?: unknown, rawBody?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {},
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function verdict(name: string, pass: boolean, context: string): void {
  step += 1;
  const tag = pass ? "PASS" : "FAIL";
  console.log("  verdict: " + tag + " -- " + context);
  console.log("[step " + step + "] " + tag + " " + name);
  console.log("");
  if (!pass) failures += 1;
}

async function scenario(name: string, fn: () => Promise<{ pass: boolean; context: string }>) {
  console.log("=== scenario: " + name + " ===");
  try {
    const { pass, context } = await fn();
    verdict(name, pass, context);
  } catch (err) {
    verdict(name, false, "exception: " + (err instanceof Error ? err.message : String(err)));
  }
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

async function main(): Promise<void> {
  child = spawn(process.execPath, ["src/main.ts"], {
    env: { ...process.env, SNAPSHOT_PORT: String(PORT), SNAPSHOT_DB: join(tmpDir, "accept.db") },
    stdio: "inherit",
  });

  await waitForServer();
  console.log("server healthy on " + BASE + "\n");

  const KEY = "accept.user";

  await scenario("01 first call auto-creates snapshot", async () => {
    const body = { key: KEY, data: { user: { name: "ann", address: { city: "beijing" }, tags: ["a", "b"] }, meta: { timestamp: 1000 } } };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    const pass = r.status === 201 && r.json?.ok === true && r.json?.data?.status === "created"
      && typeof r.json?.runId === "string";
    return { pass, context: "expected 201 + status=created + runId" };
  });

  await scenario("02 identical payload passes", async () => {
    const body = { key: KEY, data: { user: { name: "ann", address: { city: "beijing" }, tags: ["a", "b"] }, meta: { timestamp: 1000 } } };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    return { pass: r.json?.data?.status === "passed", context: "expected status=passed" };
  });

  await scenario("03 nested field change located at exact path", async () => {
    const body = { key: KEY, data: { user: { name: "ann", address: { city: "shanghai" }, tags: ["a", "b"] }, meta: { timestamp: 1000 } } };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    const diff = r.json?.data?.diff ?? [];
    const hit = diff.find((d: { path: string }) => d.path === "user.address.city");
    const pass = r.json?.data?.status === "failed" && diff.length === 1
      && hit?.kind === "changed" && hit?.before === "beijing" && hit?.after === "shanghai";
    return { pass, context: "expected failed + diff[user.address.city: beijing->shanghai]" };
  });

  await scenario("04 array element add/remove detected", async () => {
    const body = { key: KEY, data: { user: { name: "ann", address: { city: "beijing" }, tags: ["a", "b", "c"] }, meta: { timestamp: 1000 } } };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    const diff = r.json?.data?.diff ?? [];
    const hit = diff.find((d: { path: string }) => d.path === "user.tags[2]");
    const pass = r.json?.data?.status === "failed" && hit?.kind === "added" && hit?.after === "c";
    return { pass, context: "expected failed + diff[user.tags[2] added 'c']" };
  });

  await scenario("05 ignored field path (timestamp) passes", async () => {
    const body = {
      key: KEY,
      data: { user: { name: "ann", address: { city: "beijing" }, tags: ["a", "b"] }, meta: { timestamp: 999999 } },
      ignorePaths: ["meta.timestamp"],
    };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    const pass = r.json?.data?.status === "passed"
      && r.json?.data?.reason === "differences exist only on ignored paths";
    return { pass, context: "expected passed (diff only on ignored meta.timestamp)" };
  });

  await scenario("06 force update rewrites baseline", async () => {
    const upd = { key: KEY, data: { user: { name: "ann", address: { city: "shanghai" }, tags: ["a", "b"] }, meta: { timestamp: 1000 } } };
    const r1 = await request("POST", "/snapshots/update", upd);
    console.log("  request : POST /snapshots/update " + print(upd));
    console.log("  response: " + r1.status + " " + print(r1.json));
    const r2 = await request("POST", "/snapshots/compare", upd);
    console.log("  request : POST /snapshots/compare " + print(upd));
    console.log("  response: " + r2.status + " " + print(r2.json));
    const pass = r1.json?.data?.status === "updated" && r2.json?.data?.status === "passed";
    return { pass, context: "expected update -> updated, then compare -> passed" };
  });

  await scenario("07 invalid input classified as INPUT_ERROR (400)", async () => {
    const r = await request("POST", "/snapshots/compare", undefined, "{broken json");
    console.log("  request : POST /snapshots/compare body='{broken json'");
    console.log("  response: " + r.status + " " + print(r.json));
    const pass = r.status === 400 && r.json?.ok === false && r.json?.error?.category === "INPUT_ERROR";
    return { pass, context: "expected 400 INPUT_ERROR" };
  });

  await scenario("08 state conflict classified as STATE_CONFLICT (409)", async () => {
    const body = { key: "accept.ghost", data: { v: 1 } };
    const r = await request("POST", "/snapshots/update", body);
    console.log("  request : POST /snapshots/update " + print(body));
    console.log("  response: " + r.status + " " + print(r.json));
    const pass = r.status === 409 && r.json?.error?.category === "STATE_CONFLICT";
    return { pass, context: "expected 409 STATE_CONFLICT (update missing snapshot)" };
  });

  await scenario("09 oversized payload classified as RESOURCE_EXHAUSTED (413)", async () => {
    const body = { key: "accept.big", data: { blob: "x".repeat(2 * 1024 * 1024) } };
    const r = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare body={blob: 2MB of 'x'}");
    console.log("  response: " + r.status + " " + print(r.json));
    const pass = r.status === 413 && r.json?.error?.category === "RESOURCE_EXHAUSTED";
    return { pass, context: "expected 413 RESOURCE_EXHAUSTED" };
  });

  await scenario("10 run log replayable by runId", async () => {
    const body = { key: KEY, data: { user: { name: "ann", address: { city: "guangzhou" }, tags: ["a", "b"] }, meta: { timestamp: 1000 } } };
    const r1 = await request("POST", "/snapshots/compare", body);
    console.log("  request : POST /snapshots/compare " + print(body));
    console.log("  response: " + r1.status + " " + print(r1.json));
    const runId = r1.json?.runId;
    const r2 = await request("GET", "/runs/" + runId);
    console.log("  request : GET /runs/" + runId);
    console.log("  response: " + r2.status + " " + print(r2.json));
    const pass = r1.json?.data?.status === "failed"
      && r2.json?.data?.runId === runId
      && r2.json?.data?.status === "failed"
      && typeof r2.json?.data?.reason === "string";
    return { pass, context: "expected failed run replayable via GET /runs/:runId" };
  });

  console.log("=========================================");
  console.log(failures === 0 ? "ALL " + step + " SCENARIOS PASSED" : failures + " of " + step + " SCENARIOS FAILED");
}

main()
  .catch((err) => {
    console.error("accept harness error:", err);
    failures += 1;
  })
  .finally(() => {
    if (child) child.kill();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(failures === 0 ? 0 : 1);
  });
