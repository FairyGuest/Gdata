// One-shot acceptance drill. Boots the real HTTP service (virtual clock,
// file-backed SQLite), walks every lifecycle scenario in a fixed order, and
// prints request / response / verdict per step. Exit 0 = all pass, 1 = any
// failure (failing scenarios are listed on stderr).
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { rmSync } from "node:fs";

const DB_PATH = "./data/accept-run.db";
rmSync(DB_PATH, { force: true });

const env = {
  TUNNEL_HTTP_PORT: "0",
  TUNNEL_PORT_START: "20000",
  TUNNEL_PORT_END: "20004",
  TUNNEL_LEASE_TTL_MS: "1000",
  TUNNEL_DB_PATH: DB_PATH,
  TUNNEL_CLOCK: "virtual",
  TUNNEL_VIRTUAL_START_MS: "1000000",
  RUN_ID: "accept-" + Date.now().toString(36),
};
const config = loadConfig(env);
const logLines: string[] = [];
const { app } = buildServer(config, { log: (e, f) => logLines.push(JSON.stringify({ event: e, ...f })) });
await app.listen({ host: "127.0.0.1", port: 0 });
const addr = app.server.address();
const base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);

console.log("=== tunnel-lease acceptance ===");
console.log("runId=" + config.runId + " base=" + base + " range=20000..20004 ttl=1000ms clock=virtual@1000000");

let failures = 0;
const failedScenarios: string[] = [];
let scenario = "";

function begin(name: string): void {
  scenario = name;
  console.log("\n--- " + name + " ---");
}

function judge(cond: boolean, reason: string): void {
  if (cond) {
    console.log("  PASS  " + reason);
  } else {
    failures++;
    if (!failedScenarios.includes(scenario)) failedScenarios.push(scenario);
    console.log("  FAIL  " + reason);
  }
}

interface Resp { status: number; body: Record<string, unknown> }

async function req(method: string, path: string, body?: unknown): Promise<Resp> {
  const init: Record<string, unknown> = { method, headers: {} as Record<string, string> };
  if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)["content-type"] = "application/json"; }
  const res = await fetch(base + path, init);
  const json = await res.json() as Record<string, unknown>;
  console.log("  > " + method + " " + path + (body !== undefined ? " " + JSON.stringify(body) : ""));
  console.log("  < " + res.status + " " + JSON.stringify(json));
  return { status: res.status, body: json };
}

function leaseOf(r: Resp): Record<string, unknown> {
  return r.body.lease as Record<string, unknown>;
}
function errCode(r: Resp): string {
  return ((r.body.error as Record<string, unknown>) ?? {}).code as string;
}

// S1: auto allocation is unique and ascending.
begin("S1 auto-allocation: unique ascending ports");
const t1 = leaseOf(await req("POST", "/leases", { target: "ssh://host-a:22" }));
const t2 = leaseOf(await req("POST", "/leases", { target: "ssh://host-b:22" }));
judge(t1.port === 20000 && t2.port === 20001 && t1.id !== t2.id,
  "ports 20000/20001 distinct, got " + t1.port + "/" + t2.port);
judge(t1.expiresAt === 1000000 + 1000, "t1 expiresAt = createdAt + ttl = 1001000, got " + t1.expiresAt);

// S2: preferred port granted when free, conflict reports the occupant.
begin("S2 preferred port: grant + 409 conflict with occupant");
const t3r = await req("POST", "/leases", { target: "rdp://host-c:3389", preferredPort: 20003 });
const t3 = leaseOf(t3r);
judge(t3r.status === 201 && t3.port === 20003, "preferred 20003 granted");
const conflict = await req("POST", "/leases", { target: "rdp://host-d:3389", preferredPort: 20003 });
const occupant = ((conflict.body.error as Record<string, unknown>)?.details as Record<string, unknown>)?.occupant as Record<string, unknown>;
judge(conflict.status === 409 && errCode(conflict) === "PORT_CONFLICT" && occupant?.leaseId === t3.id,
  "409 PORT_CONFLICT, occupant=" + JSON.stringify(occupant));

// S3: heartbeat boundary - exactly at deadline renews, one tick late expires.
begin("S3 heartbeat boundary: on-time renew vs one-tick-late expiry");
await req("POST", "/diagnostics/clock/advance", { ms: 1000 }); // now == t1.expiresAt
const onTime = await req("POST", "/leases/" + t1.id + "/heartbeat");
judge(onTime.status === 200 && leaseOf(onTime).expiresAt === 1000000 + 2000,
  "heartbeat exactly at deadline renewed, expiresAt=1002000, got " + leaseOf(onTime).expiresAt);
await req("POST", "/diagnostics/clock/advance", { ms: 1001 }); // one tick past new deadline
const late = await req("POST", "/leases/" + t1.id + "/heartbeat");
judge(late.status === 409 && errCode(late) === "LEASE_EXPIRED", "late heartbeat -> 409 LEASE_EXPIRED, got " + late.status + "/" + errCode(late));

// S4: expired lease's port is reclaimed and reused by a new registration.
begin("S4 expiry reclaims port; new registration reuses it");
const t5r = await req("POST", "/leases", { target: "ssh://host-e:22" });
const t5 = leaseOf(t5r);
judge(t5r.status === 201 && t5.port === 20000, "port 20000 reused after t1 expired, got " + t5.port);
const expiredList = await req("GET", "/leases?status=expired");
const expiredIds = (expiredList.body.leases as Record<string, unknown>[]).map((l) => l.id);
judge(expiredList.status === 200 && expiredIds.includes(t1.id as string),
  "t1 visible as expired in SQLite history");

// S5: explicit release frees the port; later heartbeats fail as LEASE_RELEASED.
begin("S5 explicit release: instant free, heartbeat fails, port re-allocatable");
const t6 = leaseOf(await req("POST", "/leases", { target: "vnc://host-f:5900", preferredPort: 20004 }));
const rel = await req("POST", "/leases/" + t6.id + "/release");
judge(rel.status === 200 && leaseOf(rel).status === "released", "release ok, status=released");
const hbAfterRelease = await req("POST", "/leases/" + t6.id + "/heartbeat");
judge(hbAfterRelease.status === 409 && errCode(hbAfterRelease) === "LEASE_RELEASED",
  "heartbeat after release -> 409 LEASE_RELEASED, got " + hbAfterRelease.status + "/" + errCode(hbAfterRelease));
const t7r = await req("POST", "/leases", { target: "vnc://host-g:5900", preferredPort: 20004 });
judge(t7r.status === 201 && leaseOf(t7r).port === 20004, "released port 20004 re-allocated");

// S6: forwarding table filters by target and status; terminal states distinct.
begin("S6 forwarding table: target/status filters, expired vs released distinct");
const tabExpired = await req("GET", "/forwarding-table?status=expired");
const tabReleased = await req("GET", "/forwarding-table?status=released");
const tabTarget = await req("GET", "/forwarding-table?target=ssh://host-e:22");
const expEntries = tabExpired.body.entries as Record<string, unknown>[];
const relEntries = tabReleased.body.entries as Record<string, unknown>[];
judge(expEntries.some((e) => e.id === t1.id) && !expEntries.some((e) => e.id === t6.id),
  "status=expired contains t1, not t6");
judge(relEntries.some((e) => e.id === t6.id) && !relEntries.some((e) => e.id === t1.id),
  "status=released contains t6, not t1");
judge((tabTarget.body.entries as unknown[]).length === 1, "target filter returns exactly the t5 row");

// S7: range exhaustion -> 503 RESOURCE_EXHAUSTED.
begin("S7 resource exhaustion: full range -> 503");
const f1 = leaseOf(await req("POST", "/leases", { target: "fill-1" }));
const f2 = leaseOf(await req("POST", "/leases", { target: "fill-2" }));
const f3 = leaseOf(await req("POST", "/leases", { target: "fill-3" }));
judge(f1.port === 20001 && f2.port === 20002 && f3.port === 20003,
  "remaining ports 20001..20003 filled, got " + f1.port + "/" + f2.port + "/" + f3.port);
const overflow = await req("POST", "/leases", { target: "fill-4" });
judge(overflow.status === 503 && errCode(overflow) === "RESOURCE_EXHAUSTED",
  "overflow -> 503 RESOURCE_EXHAUSTED, got " + overflow.status + "/" + errCode(overflow));

// S8: malformed input -> 400 INVALID_INPUT (not a silent success).
begin("S8 input errors: 400 INVALID_INPUT");
const badBody = await req("POST", "/leases", {});
judge(badBody.status === 400 && errCode(badBody) === "INVALID_INPUT", "empty body -> 400 INVALID_INPUT");
const badQuery = await req("GET", "/leases?status=bogus");
judge(badQuery.status === 400 && errCode(badQuery) === "INVALID_INPUT", "bad status filter -> 400 INVALID_INPUT");
const missing = await req("POST", "/leases/does-not-exist/heartbeat");
judge(missing.status === 404 && errCode(missing) === "LEASE_NOT_FOUND", "unknown id -> 404 LEASE_NOT_FOUND");

// S9: clock advance is forbidden under the system clock.
begin("S9 clock guard: advance forbidden with system clock");
const sysConfig = loadConfig({ ...env, TUNNEL_CLOCK: "system", TUNNEL_DB_PATH: ":memory:", RUN_ID: config.runId });
const sys = buildServer(sysConfig, { log: () => {} });
await sys.app.listen({ host: "127.0.0.1", port: 0 });
const sysAddr = sys.app.server.address();
const sysBase = "http://127.0.0.1:" + (typeof sysAddr === "object" && sysAddr ? sysAddr.port : 0);
const forbidden = await fetch(sysBase + "/diagnostics/clock/advance", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ms: 1 }),
});
const forbiddenBody = await forbidden.json() as Record<string, unknown>;
console.log("  > POST /diagnostics/clock/advance (system clock)");
console.log("  < " + forbidden.status + " " + JSON.stringify(forbiddenBody));
judge(forbidden.status === 403 && ((forbiddenBody.error as Record<string, unknown>)?.code === "CLOCK_FORBIDDEN"),
  "system clock advance -> 403 CLOCK_FORBIDDEN");
await sys.app.close();

console.log("\n=== diagnostics snapshot ===");
const diag = await req("GET", "/diagnostics");
console.log("  counts=" + JSON.stringify((diag.body.counts)));

console.log("\n=== kernel event log (replay aid, runId=" + config.runId + ") ===");
for (const line of logLines) console.log("  " + line);

await app.close();

if (failures > 0) {
  console.error("\nRESULT: FAIL (" + failures + " failed checks) scenarios: " + failedScenarios.join("; "));
  process.exit(1);
}
console.log("\nRESULT: PASS (all scenarios)");
process.exit(0);

