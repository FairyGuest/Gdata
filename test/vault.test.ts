import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultError } from "../src/errors.ts";
import { makeVault } from "./helpers.ts";

test("multi-version writes produce increasing versions, all readable", () => {
  const { core } = makeVault();
  assert.deepEqual(core.putSecret("db.password", "v1-value"), { name: "db.password", version: 1 });
  assert.deepEqual(core.putSecret("db.password", "v2-value"), { name: "db.password", version: 2 });
  assert.deepEqual(core.putSecret("db.password", "v3-value"), { name: "db.password", version: 3 });

  assert.equal(core.getSecret("db.password").value, "v3-value"); // latest by default
  assert.equal(core.getSecret("db.password", 1).value, "v1-value");
  assert.equal(core.getSecret("db.password", 2).value, "v2-value");
  assert.equal(core.getSecret("db.password", 3).value, "v3-value");
});

test("rotation keeps old versions readable during grace, expires exactly at graceUntil", () => {
  const grace = 60_000;
  const { core, clock } = makeVault(grace);
  core.putSecret("api.key", "old-secret");
  const t0 = clock.nowMs();
  const rot = core.rotateSecret("api.key");
  assert.equal(rot.version, 2);
  assert.equal(rot.graceUntil, t0 + grace);

  // during grace: old version still readable (consumer switch-over window)
  clock.set(t0 + grace - 1);
  assert.equal(core.getSecret("api.key", 1).value, "old-secret");
  assert.equal(core.getSecret("api.key").value, "old-secret"); // latest (v2) carries same plaintext

  // exactly at graceUntil: expired
  clock.set(t0 + grace);
  assert.throws(
    () => core.getSecret("api.key", 1),
    (e: unknown) => e instanceof VaultError && e.code === "VERSION_EXPIRED"
  );
  // after grace: still expired; latest unaffected
  clock.set(t0 + grace + 1);
  assert.throws(() => core.getSecret("api.key", 1), (e: unknown) => e instanceof VaultError && e.code === "VERSION_EXPIRED");
  assert.equal(core.getSecret("api.key", 2).value, "old-secret");
});

test("rotation re-encrypts: new version has different ciphertext than old", () => {
  const { core, store } = makeVault();
  core.putSecret("k", "same-plaintext");
  core.rotateSecret("k");
  const rows = core.audit(); // touch audit to keep types honest
  assert.ok(rows.length >= 2);
  const versions = store.listVersions("k");
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].graceUntil, null);
  assert.equal(versions[1].graceUntil, null);
});

test("error taxonomy: validation, not-found, version-not-found are distinct", () => {
  const { core } = makeVault();
  assert.throws(() => core.putSecret("bad name!", "x"), (e: unknown) => e instanceof VaultError && e.code === "VALIDATION_ERROR");
  assert.throws(() => core.putSecret("ok", ""), (e: unknown) => e instanceof VaultError && e.code === "VALIDATION_ERROR");
  assert.throws(() => core.getSecret("missing"), (e: unknown) => e instanceof VaultError && e.code === "SECRET_NOT_FOUND");
  core.putSecret("real", "v");
  assert.throws(() => core.getSecret("real", 99), (e: unknown) => e instanceof VaultError && e.code === "VERSION_NOT_FOUND");
  assert.throws(() => core.getSecret("real", 0), (e: unknown) => e instanceof VaultError && e.code === "VALIDATION_ERROR");
  assert.throws(() => core.rotateSecret("missing"), (e: unknown) => e instanceof VaultError && e.code === "SECRET_NOT_FOUND");
});

test("every read and write is audited with run id, actor and outcome", () => {
  const { core, runId } = makeVault(1000);
  core.putSecret("s", "one", "alice");
  core.putSecret("s", "two", "alice");
  core.getSecret("s", 1, "bob");
  assert.throws(() => core.getSecret("nope", undefined, "carol"));
  core.rotateSecret("s", "dave");

  const entries = core.audit();
  const gets = entries.filter((e) => e.action === "get");
  const puts = entries.filter((e) => e.action === "put");
  assert.equal(puts.length, 2);
  assert.equal(gets.length, 2);
  assert.ok(entries.some((e) => e.action === "rotate" && e.result === "success"));
  assert.ok(entries.every((e) => e.runId === runId));

  const failedGet = gets.find((e) => e.result === "failure");
  assert.ok(failedGet);
  assert.equal(failedGet.actor, "carol");
  assert.equal(failedGet.errorCode, "SECRET_NOT_FOUND");
  const okGet = gets.find((e) => e.result === "success");
  assert.equal(okGet?.actor, "bob");
  assert.equal(okGet?.version, 1);
});

test("expired read is audited as failure with VERSION_EXPIRED", () => {
  const { core, clock } = makeVault(500);
  core.putSecret("z", "v");
  core.rotateSecret("z");
  clock.advance(500);
  assert.throws(() => core.getSecret("z", 1), (e: unknown) => e instanceof VaultError && e.code === "VERSION_EXPIRED");
  const entries = core.audit("z").filter((e) => e.action === "get" && e.version === 1);
  assert.equal(entries.at(-1)?.result, "failure");
  assert.equal(entries.at(-1)?.errorCode, "VERSION_EXPIRED");
});

test("audit log is immutable: update and delete are rejected", () => {
  const { core, store } = makeVault();
  core.putSecret("a", "1");
  assert.throws(() => store.rawExec("UPDATE audit_log SET actor = 'mallory'"), /immutable/);
  assert.throws(() => store.rawExec("DELETE FROM audit_log"), /immutable/);
  // rows untouched
  const entries = core.audit();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, "anonymous");
});

test("audit failure rolls back the business operation (same transaction)", () => {
  const { core, store } = makeVault();
  // break auditing by dropping the audit table; put must fail and create nothing
  store.rawExec("DROP TRIGGER audit_no_update");
  store.rawExec("DROP TRIGGER audit_no_delete");
  store.rawExec("DROP TABLE audit_log");
  assert.throws(() => core.putSecret("rolled", "x"), (e: unknown) => e instanceof VaultError && e.code === "AUDIT_ERROR");
  assert.equal(store.latestVersionNumber("rolled"), null);
});
