// One-shot acceptance runner: exercises every required lifecycle scenario in
// a fixed order against a fresh in-memory service driven by a VirtualClock.
// Prints each request, response and verdict; exits 0 only if all pass.

import { VirtualClock } from "../src/clock.ts";
import { LeaseKernel } from "../src/kernel.ts";
import { SqliteLeaseStore } from "../src/sqliteStore.ts";
import { buildServer } from "../src/server.ts";

const clock = new VirtualClock(1_000_000);
const store = new SqliteLeaseStore(":memory:");
let seq = 0;
const kernel = new LeaseKernel({
  clock, store,
  config: { portMin: 20000, portMax: 20002, leaseTtlMs: 1000 },
  idGen: () => "L" + (++seq),
});
const app = buildServer(kernel);

let failures = 0;
let stepNo = 0;

interface Resp { statusCode: number; json(): any; }
async function req(method: string, url: string, payload?: unknown): Promise<Resp> {
  return app.inject({ method, url, payload });
}

function step(title: string): void {
  stepNo += 1;
  console.log("");
  console.log("=== STEP " + stepNo + ": " + title + " ===");
}
function showReq(method: string, url: string, payload?: unknown): void {
  console.log("  -> " + method + " " + url + (payload !== undefined ? "  body=" + JSON.stringify(payload) : ""));
}
function showResp(r: Resp): void {
  console.log("  <- " + r.statusCode + "  " + JSON.stringify(r.json()));
}
function note(msg: string): void { console.log("  [clock] " + msg + " (now=" + clock.now() + ")"); }
function check(label: string, cond: boolean, actual: unknown): void {
  if (cond) {
    console.log("  PASS: " + label);
  } else {
    failures += 1;
    console.log("  FAIL: " + label + "  actual=" + JSON.stringify(actual));
  }
}

// ---------- Scenario 1: auto allocation, no duplicates; preference conflict ----------
step("auto allocation assigns smallest free ports without duplicates");
showReq("POST", "/tunnels", { target: "10.0.0.1:80" });
const a = await req("POST", "/tunnels", { target: "10.0.0.1:80" }); showResp(a);
showReq("POST", "/tunnels", { target: "10.0.0.2:80" });
const b = await req("POST", "/tunnels", { target: "10.0.0.2:80" }); showResp(b);
check("A gets 201 + port 20000", a.statusCode === 201 && a.json().lease.port === 20000, a.json());
check("B gets 201 + port 20001 (distinct)", b.statusCode === 201 && b.json().lease.port === 20001, b.json());

step("preferred port conflict is rejected with 409 + current occupant");
showReq("POST", "/tunnels", { target: "10.0.0.3:80", preferredPort: 20000 });
const conflict = await req("POST", "/tunnels", { target: "10.0.0.3:80", preferredPort: 20000 }); showResp(conflict);
const cBody = conflict.json();
check("conflict returns 409 PORT_CONFLICT",
  conflict.statusCode === 409 && cBody.error?.code === "PORT_CONFLICT", cBody);
check("conflict body names the occupant lease",
  cBody.error?.details?.occupant?.leaseId === a.json().lease.leaseId, cBody.error?.details);

// ---------- Scenario 2: expiry auto-reclaim and port reuse ----------
step("expired lease is reclaimed automatically and its port reused");
note("advance 1001ms past lease A deadline (ttl=1000)");
clock.advance(1001);
showReq("POST", "/tunnels", { target: "10.0.0.4:80" });
const d = await req("POST", "/tunnels", { target: "10.0.0.4:80" }); showResp(d);
check("new registration reuses freed port 20000",
  d.statusCode === 201 && d.json().lease.port === 20000, d.json());
showReq("GET", "/leases?status=expired");
const expiredList = await req("GET", "/leases?status=expired"); showResp(expiredList);
check("lease A recorded as expired in history",
  expiredList.json().leases.some((l: any) => l.leaseId === a.json().lease.leaseId && l.status === "expired"),
  expiredList.json());

// ---------- Scenario 3: heartbeat boundary ----------
step("heartbeat exactly at the deadline succeeds");
const dId = d.json().lease.leaseId; // registered at now=1001001, expires at 1002001
note("advance exactly 1000ms to D's expiresAt");
clock.advance(1000);
showReq("POST", "/tunnels/" + dId + "/heartbeat");
const hbOk = await req("POST", "/tunnels/" + dId + "/heartbeat"); showResp(hbOk);
check("heartbeat at exact deadline returns 200 and extends expiry to now+ttl",
  hbOk.statusCode === 200 && hbOk.json().lease.expiresAt === clock.now() + 1000, hbOk.json());

step("heartbeat one ms too late fails and the lease is expired");
note("advance 1001ms (one ms past the renewed deadline)");
clock.advance(1001);
showReq("POST", "/tunnels/" + dId + "/heartbeat");
const hbLate = await req("POST", "/tunnels/" + dId + "/heartbeat"); showResp(hbLate);
check("late heartbeat returns 409 LEASE_NOT_ACTIVE with status=expired",
  hbLate.statusCode === 409 && hbLate.json().error?.code === "LEASE_NOT_ACTIVE"
  && hbLate.json().error?.details?.status === "expired", hbLate.json());

// ---------- Scenario 4: release then reallocate; heartbeat after release fails ----------
step("explicit release frees the port immediately for reallocation");
showReq("POST", "/tunnels", { target: "10.0.0.6:80" });
const e = await req("POST", "/tunnels", { target: "10.0.0.6:80" }); showResp(e);
const eId = e.json().lease.leaseId;
const ePort = e.json().lease.port;
check("fresh lease E is active on an auto-assigned port",
  e.statusCode === 201 && e.json().lease.status === "active", e.json());
showReq("POST", "/tunnels/" + eId + "/release");
const rel = await req("POST", "/tunnels/" + eId + "/release"); showResp(rel);
check("release returns 200 with status=released",
  rel.statusCode === 200 && rel.json().lease.status === "released", rel.json());
showReq("POST", "/tunnels", { target: "10.0.0.5:80", preferredPort: ePort });
const reuse = await req("POST", "/tunnels", { target: "10.0.0.5:80", preferredPort: ePort }); showResp(reuse);
check("released port " + ePort + " is immediately re-allocatable",
  reuse.statusCode === 201 && reuse.json().lease.port === ePort, reuse.json());

step("heartbeat on a released lease fails explicitly");
showReq("POST", "/tunnels/" + eId + "/heartbeat");
const hbReleased = await req("POST", "/tunnels/" + eId + "/heartbeat"); showResp(hbReleased);
check("heartbeat after release returns 409 LEASE_NOT_ACTIVE with status=released",
  hbReleased.statusCode === 409 && hbReleased.json().error?.code === "LEASE_NOT_ACTIVE"
  && hbReleased.json().error?.details?.status === "released", hbReleased.json());

// ---------- Scenario 5: forward table distinguishes terminal states ----------
step("forward table filters by target/status and distinguishes expired vs released");
showReq("GET", "/forward-table");
const table = await req("GET", "/forward-table"); showResp(table);
const entries: any[] = table.json().entries;
const aEntry = entries.find((x) => x.leaseId === a.json().lease.leaseId);
const eEntry = entries.find((x) => x.leaseId === eId);
check("table shows expired lease A as 'expired'", aEntry?.status === "expired", aEntry);
check("table shows released lease E as 'released'", eEntry?.status === "released", eEntry);
showReq("GET", "/forward-table?status=released");
const relOnly = await req("GET", "/forward-table?status=released"); showResp(relOnly);
check("status=released filter returns exactly the released lease",
  relOnly.json().entries.length === 1 && relOnly.json().entries[0].leaseId === eId, relOnly.json());
showReq("GET", "/forward-table?target=10.0.0.5:80");
const byTarget = await req("GET", "/forward-table?target=10.0.0.5:80"); showResp(byTarget);
check("target filter returns only the matching lease",
  byTarget.json().entries.length === 1
  && byTarget.json().entries[0].leaseId === reuse.json().lease.leaseId, byTarget.json());
// ---------- Summary ----------
console.log("");
console.log("==================================================");
if (failures === 0) {
  console.log("ACCEPTANCE: ALL " + stepNo + " STEPS PASSED");
  process.exit(0);
} else {
  console.log("ACCEPTANCE: " + failures + " check(s) FAILED across " + stepNo + " steps");
  process.exit(1);
}

