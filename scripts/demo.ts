/**
 * Local demo: walks the main flows in-process with a VirtualClock so the
 * rotation grace boundary is shown deterministically (no real waiting).
 */
import { VirtualClock } from "../src/clock.ts";
import { QuotaKernel } from "../src/kernel.ts";
import { RunLogger } from "../src/logger.ts";
import { Store } from "../src/store.ts";

const runId = `demo-${Date.now()}`;
const store = new Store(":memory:");
const clock = new VirtualClock();
const kernel = new QuotaKernel(store, clock, new RunLogger(runId, "logs"));
const show = (label: string, v: unknown) => console.log(`\n== ${label} ==\n${JSON.stringify(v, null, 2)}`);

kernel.provisionKey({
  key: "ak_demo",
  scopes: [
    { tier: "global", id: "g1", limit: 100 },
    { tier: "org", id: "o1", limit: 20 },
    { tier: "project", id: "p1", limit: 5 },
  ],
});
console.log("provisioned ak_demo (global=100, org=20, project=5)");

show("consume 3 (all tiers debited)", kernel.consume("ak_demo", 3));

try {
  kernel.consume("ak_demo", 3); // project has only 2 left
} catch (err: any) {
  show("consume 3 rejected + rolled back", { code: err.code, category: err.category, details: err.details });
}
show("usage after rollback (still 3 everywhere)", kernel.usage("ak_demo"));

const rot = kernel.rotate("ak_demo", 60_000);
show("rotated (grace 60s)", rot);
kernel.consume(rot.newKey, 1);
kernel.consume("ak_demo", 1); // inside grace
show("usage: both keys share scopes", kernel.usage(rot.newKey));

clock.set(rot.graceUntil + 1);
try {
  kernel.consume("ak_demo", 1);
} catch (err: any) {
  show("old key after grace", { code: err.code, category: err.category });
}
console.log(`\ndemo complete, run log: logs/${runId}.jsonl`);

