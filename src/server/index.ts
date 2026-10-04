import { readFileSync } from "node:fs";
import { PolicyStore } from "../state/store.ts";
import { parsePolicyDocument } from "../contract/validate.ts";
import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.DB_PATH ?? "rbac.db";
const seedPath = process.env.SEED_POLICY; // optional JSON policy fixture

const store = new PolicyStore(dbPath);
if (seedPath) {
  const doc = parsePolicyDocument(JSON.parse(readFileSync(seedPath, "utf8")));
  const version = store.replacePolicy(doc);
  console.log(`seeded policy from ${seedPath} (version ${version})`);
}

const app = buildApp({ store });
app.listen({ port, host }).then(() => {
  console.log(`rbac-policy-service listening on http://${host}:${port}`);
});
