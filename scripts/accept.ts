/**
 * One-shot acceptance script: boots the real HTTP service on an ephemeral
 * port with a fresh SQLite file, then walks every required scenario in a
 * fixed order, printing request, response and verdict for each step.
 * Exit code 0 = all scenarios passed; 1 = the printed scenario failed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { SystemClock } from "../src/clock.ts";
import { QuotaKernel } from "../src/kernel.ts";
import { RunLogger } from "../src/logger.ts";
import { buildServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

const runId = `accept-${Date.now()}`;
const tmp = mkdtempSync(join(tmpdir(), "quota-accept-"));
const config = { ...loadConfig(), dbPath: join(tmp, "accept.db"), logDir: join(tmp, "logs") };
const store = new Store(config.dbPath);
const kernel = new QuotaKernel(store, new SystemClock(), new RunLogger(runId, config.logDir));
const app = buildServer(kernel, config);
await app.listen({ host: "127.0.0.1", port: 0 });
const { port } = app.server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;

let failures = 0;

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

async function step(
  scenario: string,
  method: string,
  path: string,
  body: unknown,
  expect: (status: number, json: any) => { pass: boolean; detail: string },
): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  const { pass, detail } = expect(res.status, json);
  console.log(`[${scenario}] ${method} ${path}`);
  if (body !== undefined) console.log(`  request : ${JSON.stringify(body)}`);
  console.log(`  response: ${res.status} ${JSON.stringify(json)}`);
  console.log(`  verdict : ${pass ? "PASS" : "FAIL"} - ${detail}`);
  if (!pass) failures++;
  return json;
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== Scenario: ${name} ===`);
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`  verdict : FAIL - unexpected script error: ${(err as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await scenario("1. provision key with 3-tier scope chain", async () => {
  await step("provision", "POST", "/keys", {
    key: "ak_accept",
    scopes: [
      { tier: "global", id: "g1", limit: 100 },
      { tier: "org", id: "o1", limit: 40 },
      { tier: "project", id: "p1", limit: 10 },
    ],
  }, (s, j) => ({ pass: s === 200 && j.provisioned === true, detail: "key provisioned" }));
});

await scenario("2. three-tier atomic deduction", async () => {
  await step("consume", "POST", "/quota/consume", { key: "ak_accept", amount: 4 }, (s, j) => {
    const tiers = Object.fromEntries((j.balances ?? []).map((b: any) => [b.tier, b.used]));
    const pass = s === 200 && tiers.global === 4 && tiers.org === 4 && tiers.project === 4;
    return { pass, detail: `all tiers debited together: ${JSON.stringify(tiers)}` };
  });
});

await scenario("3. insufficient project tier -> 429 + full rollback", async () => {
  await step("consume-overflow", "POST", "/quota/consume", { key: "ak_accept", amount: 7 }, (s, j) => {
    const pass = s === 429 && j.error?.code === "QUOTA_EXHAUSTED" && j.error?.category === "resource"
      && j.error?.details?.tier === "project" && j.error?.details?.remaining === 6;
    return { pass, detail: "rejected at project tier with resource-category error" };
  });
  await step("rollback-check", "GET", "/keys/ak_accept/usage", undefined, (s, j) => {
    const used = Object.fromEntries((j.scopes ?? []).map((b: any) => [b.tier, b.used]));
    const pass = s === 200 && used.global === 4 && used.org === 4 && used.project === 4;
    return { pass, detail: `no partial deduction leaked: ${JSON.stringify(used)}` };
  });
});

await scenario("4. input error is distinguishable (400 VALIDATION_ERROR)", async () => {
  await step("bad-amount", "POST", "/quota/consume", { key: "ak_accept", amount: 0 }, (s, j) => ({
    pass: s === 400 && j.error?.code === "VALIDATION_ERROR" && j.error?.category === "input",
    detail: "malformed input rejected as input-category error",
  }));
});

await scenario("5. unknown key is distinguishable (404 KEY_NOT_FOUND)", async () => {
  await step("unknown-key", "POST", "/quota/consume", { key: "ak_ghost", amount: 1 }, (s, j) => ({
    pass: s === 404 && j.error?.code === "KEY_NOT_FOUND" && j.error?.category === "state",
    detail: "missing key reported as state-category error",
  }));
});

let rotatedKey = "";
await scenario("6. rotation: new key works, old key inside grace window", async () => {
  const rot = await step("rotate", "POST", "/keys/rotate", { key: "ak_accept", graceMs: 400 }, (s, j) => ({
    pass: s === 200 && typeof j.newKey === "string" && j.newKey !== "ak_accept" && j.graceUntil > 0,
    detail: "successor issued with grace window",
  }));
  rotatedKey = rot.newKey;
  await step("new-key-consume", "POST", "/quota/consume", { key: rotatedKey, amount: 1 }, (s, j) => ({
    pass: s === 200, detail: "new key consumes against the same scope chain",
  }));
  await step("old-key-in-grace", "POST", "/quota/consume", { key: "ak_accept", amount: 1 }, (s, j) => ({
    pass: s === 200, detail: "old key still valid inside grace window",
  }));
  await step("shared-scopes", "GET", `/keys/${rotatedKey}/usage`, undefined, (s, j) => {
    const g = (j.scopes ?? []).find((b: any) => b.tier === "global");
    return { pass: s === 200 && g.used === 6, detail: `both keys share scopes, global.used=${g?.used}` };
  });
});

await scenario("7. grace expiry: old key -> 410 KEY_EXPIRED, new key unaffected", async () => {
  console.log("  waiting 500ms for the 400ms grace window to lapse...");
  await sleep(500);
  await step("old-key-expired", "POST", "/quota/consume", { key: "ak_accept", amount: 1 }, (s, j) => ({
    pass: s === 410 && j.error?.code === "KEY_EXPIRED" && j.error?.category === "state",
    detail: "old key rejected after grace period",
  }));
  await step("new-key-still-ok", "POST", "/quota/consume", { key: rotatedKey, amount: 1 }, (s) => ({
    pass: s === 200, detail: "new key unaffected by old key expiry",
  }));
});

await scenario("8. double rotation is a state conflict (409)", async () => {
  await step("double-rotate", "POST", "/keys/rotate", { key: "ak_accept", graceMs: 1000 }, (s, j) => ({
    pass: s === 409 && j.error?.code === "ROTATION_CONFLICT" && j.error?.category === "state",
    detail: "re-rotating a rotated key rejected",
  }));
});

await scenario("9. concurrent consumption: balance conservation", async () => {
  // remaining project budget after scenarios above: 10 - 4 - 1 - 1 - 1 = 3
  const ATTEMPTS = 20;
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, () =>
      fetch(base + "/quota/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: rotatedKey, amount: 1 }),
      }).then((r) => r.status),
    ),
  );
  const ok = results.filter((s) => s === 200).length;
  const exhausted = results.filter((s) => s === 429).length;
  const usageRes = await fetch(base + `/keys/${rotatedKey}/usage`);
  const usage = await usageRes.json();
  const project = usage.scopes.find((b: any) => b.tier === "project");
  const pass = ok === 3 && exhausted === ATTEMPTS - 3 && project.used === 10 && project.remaining === 0;
  console.log(`[concurrency] 20 parallel consumers vs 3 remaining units`);
  console.log(`  response: ${ok} succeeded, ${exhausted} rejected; project.used=${project.used}/${project.limit}`);
  console.log(`  verdict : ${pass ? "PASS" : "FAIL"} - exactly the remaining budget consumed, no lost updates`);
  if (!pass) failures++;
});

await app.close();
store.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\nrunId=${runId}`);
if (failures > 0) {
  console.error(`ACCEPTANCE FAILED: ${failures} step(s) failed`);
  process.exit(1);
}
console.log("ACCEPTANCE PASSED: all scenarios green");


