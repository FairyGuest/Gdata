import { AuditStore } from "../src/state/store";
import { verifyChain } from "../src/core/chain";

const dbPath = process.env.AUDIT_DB ?? "demo.db";
const store = new AuditStore(dbPath);

const samples = [
  { actor: "alice", action: "login", resource: "session" },
  { actor: "alice", action: "create", resource: "doc-1", metadata: { size: 128 } },
  { actor: "bob", action: "approve", resource: "doc-1" },
];

for (const s of samples) {
  const e = store.append(s);
  console.log("appended seq=" + e.seq + " hash=" + e.hash.slice(0, 16) + "...");
}

const result = verifyChain(store.all());
console.log("verify:", result);
console.log("demo db written to " + dbPath);
store.close();
