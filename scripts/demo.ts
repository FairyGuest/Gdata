/**
 * Local demo: boots the server on an ephemeral port with an in-memory DB,
 * walks through the main scenarios, and shuts down.
 */
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

const server = await startServer(loadConfig({ port: 0, dbPath: ":memory:" }));
const base = `http://127.0.0.1:${server.port}`;
console.log(`demo server on ${base} (adapter: ${server.adapter})`);

const schema = {
  fields: {
    name: { type: "string", minLength: 3, maxLength: 8 },
    age: { type: "integer", min: 18, max: 65 },
    role: { type: "enum", values: ["admin", "user"] },
    hired: { type: "date", min: "2020-01-01", max: "2024-12-31" },
    tags: { type: "array", items: { type: "string", maxLength: 4 }, minItems: 1, maxItems: 3 },
  },
};

async function post(path: string, payload: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const first = await post("/generate", { seed: 42, count: 3, schema });
console.log("generate (seed=42):", JSON.stringify(first.body.rows, null, 2));

const second = await post("/generate", { seed: 42, count: 3, schema });
console.log("same seed reproducible:", JSON.stringify(first.body.rows) === JSON.stringify(second.body.rows));

await post("/datasets", { id: "demo-users", seed: 42, count: 3, schema });
const verify = await post("/datasets/demo-users/verify", {});
console.log("saved dataset verify match:", verify.body.match);

const conflict = await post("/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "integer", min: 9, max: 2 } } } });
console.log("conflict response:", conflict.status, JSON.stringify(conflict.body.error));

await server.close();

