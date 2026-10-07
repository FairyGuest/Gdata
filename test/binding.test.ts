import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../src/state/store.ts";
import { BindingService } from "../src/service/service.ts";
import { MemoryRunLogger } from "../src/service/logger.ts";
import { AppError } from "../src/domain/errors.ts";

const FP_LEN = 12;
// Reference fingerprints computed independently of the implementation under test.
const fp = (v: string) => createHash("sha256").update(v, "utf8").digest("hex").slice(0, FP_LEN);

function makeService() {
  const store = new Store(":memory:");
  const logger = new MemoryRunLogger();
  const service = new BindingService(store, FP_LEN, logger);
  return { store, service, logger };
}

function seedThreeLevels(service: BindingService) {
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "API_KEY", value: "org-value" });
  service.declareSecret({ scopeType: "project", scopeId: "proj-1", name: "API_KEY", value: "proj-value" });
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "DB_URL", value: "org-db" });
  service.declareSecret({ scopeType: "project", scopeId: "proj-1", name: "DB_URL", value: "proj-db" });
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "REGION", value: "org-region" });
}

test("nearest-scope override: env > project > org, decided per key", () => {
  const { service } = makeService();
  seedThreeLevels(service);
  // env-level declaration requires the env id, which only exists after creation;
  // declare it via a first environment chain by pre-creating at env scope is not
  // possible, so org+project+env override is verified in two steps below.
  const created = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "staging",
    requiredSecrets: ["API_KEY", "DB_URL", "REGION"],
  });
  const byName = new Map(created.resolved.map((r) => [r.name, r]));
  assert.equal(byName.get("API_KEY")!.level, "project");
  assert.equal(byName.get("API_KEY")!.value, "proj-value");
  assert.equal(byName.get("DB_URL")!.level, "project");
  assert.equal(byName.get("REGION")!.level, "org");
  assert.equal(byName.get("REGION")!.sourcePath, "org:org-1");
  assert.equal(byName.get("API_KEY")!.sourcePath, "org:org-1/project:proj-1");

  // Now add an env-level override for the same env and re-resolve a second env.
  service.declareSecret({ scopeType: "env", scopeId: created.environment.id, name: "API_KEY", value: "env-value" });
  const created2 = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "staging-2",
    requiredSecrets: ["API_KEY"],
  });
  // env scope of a *new* env has no declarations, so project still wins there.
  assert.equal(created2.resolved[0].level, "project");

  // Direct kernel check for env-level override on the first env's chain.
  const { service: svc2 } = makeService();
  svc2.declareSecret({ scopeType: "org", scopeId: "o", name: "K", value: "v-org" });
  svc2.declareSecret({ scopeType: "project", scopeId: "p", name: "K", value: "v-proj" });
  const envA = svc2.createEnvironment({ orgId: "o", projectId: "p", name: "e1", requiredSecrets: ["K"] });
  svc2.declareSecret({ scopeType: "env", scopeId: envA.environment.id, name: "K", value: "v-env" });
  const envB = svc2.createEnvironment({ orgId: "o", projectId: "p", name: "e2", requiredSecrets: ["K"] });
  assert.equal(envB.resolved[0].level, "project"); // envB's own env scope has nothing
  // Re-resolve envA's chain manually: declare at envA scope then create envC under same org/project
  // but env-level declarations are per-env, so verify via snapshot of envA unchanged.
  const snapA = svc2.getEnvironmentSnapshot(envA.environment.id);
  assert.equal(snapA.snapshot[0].value, "v-proj");
});

test("env-level override wins when declared for that exact env (kernel-level)", async () => {
  const { resolveSecrets } = await import("../src/domain/resolver.ts");
  const chain = [
    { scopeType: "org" as const, scopeId: "o" },
    { scopeType: "project" as const, scopeId: "p" },
    { scopeType: "env" as const, scopeId: "e" },
  ];
  const decls = [
    { id: "1", scopeType: "org" as const, scopeId: "o", name: "K", value: "v-org", version: 1, createdAt: "t" },
    { id: "2", scopeType: "project" as const, scopeId: "p", name: "K", value: "v-proj", version: 1, createdAt: "t" },
    { id: "3", scopeType: "env" as const, scopeId: "e", name: "K", value: "v-env", version: 1, createdAt: "t" },
  ];
  const [r] = resolveSecrets(["K"], chain, decls, FP_LEN);
  assert.equal(r.level, "env");
  assert.equal(r.value, "v-env");
  assert.equal(r.sourcePath, "org:o/project:p/env:e");
  assert.equal(r.fingerprint, fp("v-env"));
});

test("snapshot isolation: later declaration updates do not affect existing env", () => {
  const { service } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "TOKEN", value: "v1" });
  const env = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "prod",
    requiredSecrets: ["TOKEN"],
  });
  assert.equal(env.resolved[0].declarationVersion, 1);
  assert.equal(env.resolved[0].fingerprint, fp("v1"));

  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "TOKEN", value: "v2" });
  const after = service.getEnvironmentSecrets(env.environment.id);
  assert.equal(after[0].fingerprint, fp("v1")); // still the creation-time value
  const snap = service.getEnvironmentSnapshot(env.environment.id);
  assert.equal(snap.snapshot[0].declarationVersion, 1);
  assert.equal(snap.snapshot[0].value, "v1");
});

test("masked query returns name/level/fingerprint only, no plaintext", () => {
  const { service } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "PASSWORD", value: "super-secret" });
  const env = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "dev",
    requiredSecrets: ["PASSWORD"],
  });
  const listed = service.getEnvironmentSecrets(env.environment.id);
  assert.deepEqual(listed, [{ name: "PASSWORD", level: "org", fingerprint: fp("super-secret") }]);
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes("super-secret"), "plaintext must not leak");
  assert.ok(!("value" in listed[0]));
});

test("missing secret names are rejected with the missing names", () => {
  const { service } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "KNOWN", value: "x" });
  assert.throws(
    () =>
      service.createEnvironment({
        orgId: "org-1",
        projectId: "proj-1",
        name: "broken",
        requiredSecrets: ["KNOWN", "GHOST_A", "GHOST_B"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "MISSING_SECRETS");
      assert.deepEqual((err.details as { missing: string[] }).missing, ["GHOST_A", "GHOST_B"]);
      return true;
    },
  );
});

test("deleting a referenced declaration returns CONFLICT_REFERENCED with referrers", () => {
  const { service } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "API_KEY", value: "k" });
  const env = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "staging",
    requiredSecrets: ["API_KEY"],
  });
  assert.throws(
    () => service.deleteDeclaration("org", "org-1", "API_KEY"),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "CONFLICT_REFERENCED");
      const refs = (err.details as { referencedBy: { envId: string }[] }).referencedBy;
      assert.equal(refs.length, 1);
      assert.equal(refs[0].envId, env.environment.id);
      return true;
    },
  );
  // After deleting the environment, the declaration becomes deletable.
  service.deleteEnvironment(env.environment.id);
  service.deleteDeclaration("org", "org-1", "API_KEY");
  assert.equal(service.queryBindings({ envId: env.environment.id }).length, 0);
});

test("deleting an environment cascades its snapshots", () => {
  const { service, store } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "S", value: "v" });
  const env = service.createEnvironment({
    orgId: "org-1",
    projectId: "proj-1",
    name: "tmp",
    requiredSecrets: ["S"],
  });
  assert.equal(store.snapshotsForEnvironment(env.environment.id).length, 1);
  service.deleteEnvironment(env.environment.id);
  assert.equal(store.snapshotsForEnvironment(env.environment.id).length, 0);
  assert.equal(store.getEnvironment(env.environment.id)!.status, "deleted");
});

test("bindings queryable by env and by secret name", () => {
  const { service } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "org-1", name: "SHARED", value: "s" });
  const e1 = service.createEnvironment({ orgId: "org-1", projectId: "p1", name: "e1", requiredSecrets: ["SHARED"] });
  const e2 = service.createEnvironment({ orgId: "org-1", projectId: "p2", name: "e2", requiredSecrets: ["SHARED"] });
  const byName = service.queryBindings({ name: "SHARED" });
  assert.equal(byName.length, 2);
  const byEnv = service.queryBindings({ envId: e1.environment.id });
  assert.equal(byEnv.length, 1);
  assert.equal(byEnv[0].envId, e1.environment.id);
  assert.notEqual(e1.environment.id, e2.environment.id);
});

test("run log records runId, intermediate state and reasons", () => {
  const { service, logger } = makeService();
  service.declareSecret({ scopeType: "org", scopeId: "o", name: "K", value: "v" }, "run-1");
  service.createEnvironment({ orgId: "o", projectId: "p", name: "e", requiredSecrets: ["K"] }, "run-2");
  const run2 = logger.entries.filter((e) => e.runId === "run-2");
  assert.ok(run2.length >= 2);
  assert.ok(run2.every((e) => e.reason && e.step));
  assert.equal(run2.at(-1)!.outcome, "ok");
});
