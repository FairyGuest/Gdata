import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RunStore } from "../src/state/store.ts";
import { DriftService, parseDriftInput } from "../src/core/service.ts";
import { AppError } from "../src/contracts/errors.ts";

const silentLogger = { info() {} };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

function makeInput(snapshotName: string) {
  return {
    env: "staging",
    layers: {
      base: fixture("base.json"),
      env: fixture("env.staging.json"),
      instance: fixture("instance.json"),
    },
    snapshot: fixture(snapshotName),
  };
}

let store: RunStore;
let service: DriftService;

before(() => {
  store = new RunStore(":memory:");
  service = new DriftService(store, silentLogger);
});

after(() => store.close());

test("end-to-end drift run against drifting snapshot", () => {
  const out = service.runDriftCheck(parseDriftInput(makeInput("snapshot.drifting.json")));
  assert.equal(out.report.status, "DRIFT");
  // effective config: legacyExport deleted, tags replaced, port overridden
  assert.deepEqual(out.merge.effective["features"], { betaUI: true });
  assert.deepEqual(out.merge.effective["tags"], ["core", "billing", "staging"]);
  assert.equal((out.merge.effective["http"] as Record<string, unknown>)["port"], 9090);
  assert.deepEqual(
    out.report.drifts.map((d) => [d.kind, d.path]),
    [
      ["missing_required", "http.timeouts.writeMs"],
      ["value_mismatch", "service.replicas"],
      ["extra_in_snapshot", "runtimeOnly"],
    ],
  );
});

test("clean snapshot passes", () => {
  const out = service.runDriftCheck(parseDriftInput(makeInput("snapshot.clean.json")));
  assert.equal(out.report.status, "PASS");
  assert.deepEqual(out.report.drifts, []);
});

test("runs are persisted and replayable by env", () => {
  const out = service.runDriftCheck(parseDriftInput(makeInput("snapshot.drifting.json")));
  const record = service.replay(out.runId, "staging");
  assert.equal(record.runId, out.runId);
  assert.deepEqual(record.report, out.report);
  assert.deepEqual(record.input.layers.base, fixture("base.json"));
  const runs = service.listRuns("staging");
  assert.ok(runs.some((r) => r.runId === out.runId));
});

test("replay with wrong env is a STATE_CONFLICT", () => {
  const out = service.runDriftCheck(parseDriftInput(makeInput("snapshot.clean.json")));
  assert.throws(
    () => service.replay(out.runId, "production"),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.category, "STATE_CONFLICT");
      return true;
    },
  );
});

test("replay of unknown run is NOT_FOUND", () => {
  assert.throws(
    () => service.replay("00000000-0000-0000-0000-000000000000"),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.category, "NOT_FOUND");
      return true;
    },
  );
});

test("invalid layer structure is rejected as INPUT_ERROR via parse+run", () => {
  const input = makeInput("snapshot.clean.json") as Record<string, unknown>;
  (input["layers"] as Record<string, unknown>)["env"] = [1, 2, 3];
  assert.throws(
    () => service.runDriftCheck(parseDriftInput(input)),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.category, "INPUT_ERROR");
      assert.equal(err.detail["layer"], "env");
      return true;
    },
  );
});

test("malformed request bodies are INPUT_ERROR", () => {
  for (const bad of [null, [], "x", {}, { env: "e" }, { env: "e", layers: {} }]) {
    assert.throws(() => parseDriftInput(bad), (err: unknown) => err instanceof AppError && err.category === "INPUT_ERROR");
  }
});
