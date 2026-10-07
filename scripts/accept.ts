import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.ts";
import { BindingService } from "../src/service/service.ts";
import { buildServer } from "../src/http/server.ts";

/**
 * One-shot acceptance script: boots the real HTTP service against a throwaway
 * SQLite file, then walks every required scenario in a fixed order, printing
 * request -> response -> verdict for each step. Exit 0 iff all steps pass.
 */

const FP_LEN = 12;
// Reference fingerprints computed independently of the service implementation.
const refFp = (v: string) => createHash("sha256").update(v, "utf8").digest("hex").slice(0, FP_LEN);

let failures = 0;
let stepNo = 0;

function verdict(ok: boolean, label: string, detail: string) {
  stepNo += 1;
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log("  [" + mark + "] step " + stepNo + ": " + label + " -- " + detail);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "esb-accept-"));
  const dbPath = join(dir, "accept.db");
  const store = new Store(dbPath);
  const service = new BindingService(store, FP_LEN);
  const app = buildServer(service);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = "http://127.0.0.1:" + port;
  console.log("acceptance run against " + base + " (db: " + dbPath + ")");

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    console.log("");
    console.log("> " + method + " " + path + (body === undefined ? "" : " body=" + JSON.stringify(body)));
    console.log("< " + res.status + " " + JSON.stringify(json));
    return { status: res.status, json };
  }

  try {
    console.log("");
    console.log("=== scenario 1: nearest-scope override (org/project/env) ===");
    await call("PUT", "/scopes/org/org-1/secrets/API_KEY", { value: "org-api-key" });
    await call("PUT", "/scopes/project/proj-1/secrets/API_KEY", { value: "proj-api-key" });
    await call("PUT", "/scopes/org/org-1/secrets/DB_URL", { value: "org-db" });
    await call("PUT", "/scopes/org/org-1/secrets/REGION", { value: "org-region" });
    await call("PUT", "/scopes/env/env-a/secrets/API_KEY", { value: "env-api-key" });

    const created = await call("POST", "/environments", {
      id: "env-a", orgId: "org-1", projectId: "proj-1", name: "staging",
      requiredSecrets: ["API_KEY", "DB_URL", "REGION"],
    });
    const resolved = created.json.resolved;
    const byName: Map<string, any> = new Map(resolved.map((r: any) => [r.name, r] as [string, any]));
    verdict(created.status === 201, "env created", "status=" + created.status);
    verdict(byName.get("API_KEY")?.level === "env", "API_KEY resolved at env level", "level=" + byName.get("API_KEY")?.level);
    verdict(byName.get("DB_URL")?.level === "org", "DB_URL resolved at org level", "level=" + byName.get("DB_URL")?.level);
    verdict(byName.get("REGION")?.level === "org", "REGION resolved at org level", "level=" + byName.get("REGION")?.level);
    verdict(
      byName.get("API_KEY")?.sourcePath === "org:org-1/project:proj-1/env:env-a",
      "sourcePath reports full chain to env scope",
      "sourcePath=" + byName.get("API_KEY")?.sourcePath,
    );
    verdict(
      byName.get("API_KEY")?.fingerprint === refFp("env-api-key"),
      "fingerprint matches independently computed sha256 prefix",
      "fp=" + byName.get("API_KEY")?.fingerprint + " ref=" + refFp("env-api-key"),
    );

    const created2 = await call("POST", "/environments", {
      id: "env-b", orgId: "org-1", projectId: "proj-1", name: "qa",
      requiredSecrets: ["API_KEY"],
    });
    const r2 = created2.json.resolved[0];
    verdict(r2.level === "project" && r2.fingerprint === refFp("proj-api-key"),
      "project overrides org when no env-level declaration",
      "level=" + r2.level + " fp=" + r2.fingerprint + " ref=" + refFp("proj-api-key"));

    console.log("");
    console.log("=== scenario 2: snapshot isolation after declaration update ===");
    await call("PUT", "/scopes/org/org-1/secrets/REGION", { value: "org-region-v2" });
    const after = await call("GET", "/environments/env-a/secrets");
    const regionEntry = after.json.secrets.find((s: any) => s.name === "REGION");
    verdict(
      regionEntry?.fingerprint === refFp("org-region"),
      "env-a keeps creation-time REGION fingerprint after org update",
      "fp=" + regionEntry?.fingerprint + " ref(v1)=" + refFp("org-region") + " v2=" + refFp("org-region-v2"),
    );

    console.log("");
    console.log("=== scenario 3: masked query ===");
    const secrets = after.json.secrets;
    const keys = new Set(secrets.flatMap((s: any) => Object.keys(s)));
    const serialized = JSON.stringify(secrets);
    const leaks = ["org-api-key", "proj-api-key", "env-api-key", "org-db", "org-region"].some((v) => serialized.includes(v));
    verdict(
      [...keys].sort().join(",") === "fingerprint,level,name" && !leaks,
      "masked view exposes only name/level/fingerprint, no plaintext",
      "keys=" + [...keys].sort().join(",") + " leaks=" + leaks,
    );

    console.log("");
    console.log("=== scenario 4: missing secret rejection ===");
    const missing = await call("POST", "/environments", {
      id: "env-c", orgId: "org-1", projectId: "proj-1", name: "prod",
      requiredSecrets: ["API_KEY", "NOPE_A", "NOPE_B"],
    });
    const missingErr = missing.json?.error;
    verdict(
      missing.status === 422 && missingErr?.code === "MISSING_SECRETS"
        && JSON.stringify(missingErr?.details?.missing) === JSON.stringify(["NOPE_A", "NOPE_B"]),
      "undeclared names rejected with 422 MISSING_SECRETS listing the names",
      "status=" + missing.status + " code=" + missingErr?.code + " missing=" + JSON.stringify(missingErr?.details?.missing),
    );

    console.log("");
    console.log("=== scenario 5: referenced declaration deletion refused ===");
    const del = await call("DELETE", "/scopes/org/org-1/secrets/REGION");
    const delErr = del.json?.error;
    verdict(
      del.status === 409 && delErr?.code === "CONFLICT_REFERENCED"
        && Array.isArray(delErr?.details?.referencedBy) && delErr.details.referencedBy.length > 0,
      "delete of referenced declaration returns 409 with referrers",
      "status=" + del.status + " code=" + delErr?.code + " refs=" + JSON.stringify(delErr?.details?.referencedBy),
    );

    console.log("");
    console.log("=== scenario 6: environment deletion cascades snapshots ===");
    await call("DELETE", "/environments/env-a");
    await call("DELETE", "/environments/env-b");
    const bindAfter = await call("GET", "/bindings?name=REGION");
    const remaining = bindAfter.json.bindings;
    verdict(remaining.length === 0, "snapshots for deleted envs are gone", "remaining=" + remaining.length);
    const del2 = await call("DELETE", "/scopes/org/org-1/secrets/REGION");
    verdict(del2.status === 204, "declaration deletable once no active env references it", "status=" + del2.status);

    console.log("");
    console.log("=== scenario 7: bindings query ===");
    const byEnv = await call("GET", "/bindings?envId=env-a");
    verdict(
      byEnv.status === 200 && Array.isArray(byEnv.json.bindings),
      "bindings query by envId responds (deleted env has none)",
      "count=" + byEnv.json.bindings.length,
    );
    const badQuery = await call("GET", "/bindings");
    verdict(
      badQuery.status === 400 && badQuery.json?.error?.code === "VALIDATION_ERROR",
      "bindings query without filter rejected as VALIDATION_ERROR",
      "status=" + badQuery.status,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log("=== acceptance summary: " + (failures === 0 ? "ALL PASS" : failures + " FAILURE(S)") + " (" + stepNo + " checks) ===");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("acceptance run aborted with unexpected error:", err);
  process.exit(2);
});
