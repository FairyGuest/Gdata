// Local demo: merge the fixture layers, diff against both snapshots, print
// a human-readable summary. Uses an in-memory SQLite store.

import { readFileSync } from "node:fs";
import { RunStore } from "../src/state/store.ts";
import { DriftService } from "../src/core/service.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

const service = new DriftService(new RunStore(":memory:"), { info() {} });

const input = {
  env: "staging",
  layers: { base: fixture("base.json"), env: fixture("env.staging.json"), instance: fixture("instance.json") },
  snapshot: fixture("snapshot.drifting.json"),
};

const drifting = service.runDriftCheck(input as never);
console.log("== effective config ==");
console.log(JSON.stringify(drifting.merge.effective, null, 2));
console.log("\n== drift report (drifting snapshot) ==");
for (const d of drifting.report.drifts) {
  console.log(`  [${d.kind}] ${d.path} -- ${d.reason}`);
}

const clean = service.runDriftCheck({ ...input, snapshot: fixture("snapshot.clean.json") } as never);
console.log(`\n== clean snapshot => ${clean.report.status} ==`);

console.log("\n== replay by env ==");
for (const run of service.listRuns("staging")) {
  console.log(`  ${run.runId}  ${run.createdAt}  ${run.status}`);
}
