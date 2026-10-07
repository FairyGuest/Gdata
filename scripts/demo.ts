// Local demo: spins up the service with a VirtualClock and walks through
// register -> heartbeat -> expiry -> release -> forward table, printing state.

import { VirtualClock } from "../src/clock.ts";
import { LeaseKernel } from "../src/kernel.ts";
import { SqliteLeaseStore } from "../src/sqliteStore.ts";
import { buildServer } from "../src/server.ts";

const clock = new VirtualClock(1_000_000);
const store = new SqliteLeaseStore(":memory:");
const kernel = new LeaseKernel({
  clock, store, config: { portMin: 20000, portMax: 20004, leaseTtlMs: 5000 },
});
const app = buildServer(kernel);

const show = async (label: string, p: Promise<{ statusCode: number; json(): unknown }>) => {
  const r = await p;
  console.log(label.padEnd(34), r.statusCode, JSON.stringify(r.json()));
};

console.log("== demo: ttl=5000ms, ports 20000-20004 ==");
const reg = await app.inject({ method: "POST", url: "/tunnels", payload: { target: "127.0.0.1:5432", preferredPort: 20002 } });
const id = (reg.json() as any).lease.leaseId;
await show("register preferred 20002:", Promise.resolve(reg));
await show("conflict on 20002:", app.inject({ method: "POST", url: "/tunnels", payload: { target: "x", preferredPort: 20002 } }));
clock.advance(4000);
await show("heartbeat at t+4000:", app.inject({ method: "POST", url: "/tunnels/" + id + "/heartbeat" }));
clock.advance(6000); // past renewed deadline
await show("heartbeat after expiry:", app.inject({ method: "POST", url: "/tunnels/" + id + "/heartbeat" }));
await show("auto alloc reuses 20002:", app.inject({ method: "POST", url: "/tunnels", payload: { target: "127.0.0.1:8080" } }));
await show("forward table:", app.inject({ method: "GET", url: "/forward-table" }));
console.log("== demo done ==");

