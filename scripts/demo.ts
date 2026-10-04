// Local demo: seeds a small fixture (diamond roles + mixed allow/deny
// policies), then prints a few example decisions. Uses an in-memory DB.
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig({ RBAC_DB_PATH: ":memory:" } as NodeJS.ProcessEnv);
const { app } = buildApp(config);

const put = (url: string, payload: object) => app.inject({ method: "PUT", url, payload });
const check = (roles: string[], resource: string, action: string) =>
  app.inject({ method: "POST", url: "/check", payload: { subject: { roles }, resource, action } });

await put("/roles/base", { inherits: [] });
await put("/roles/left", { inherits: ["base"] });
await put("/roles/right", { inherits: ["base"] });
await put("/roles/grand", { inherits: ["left", "right"] });
await put("/policies/p1", { role: "base", resource: "docs/*", action: "read", effect: "allow" });
await put("/policies/p2", { role: "right", resource: "docs/secret", action: "read", effect: "deny" });

for (const [roles, resource, action] of [
  [["grand"], "docs/readme", "read"],
  [["grand"], "docs/secret", "read"],
  [["left"], "admin/panel", "read"],
] as const) {
  const res = await check([...roles], resource, action);
  const d = res.json();
  console.log(`${roles} ${action} ${resource} -> allowed=${d.allowed} (${d.reasons.join("; ")})`);
}
await app.close();

