import { Store } from "../src/state/store.ts";
import { BindingService } from "../src/service/service.ts";

const store = new Store(":memory:");
const service = new BindingService(store, 12);

console.log("=== demo: scoped secret binding & injection ===");

service.declareSecret({ scopeType: "org", scopeId: "org-acme", name: "API_KEY", value: "org-api-key" });
service.declareSecret({ scopeType: "project", scopeId: "proj-shop", name: "API_KEY", value: "proj-api-key" });
service.declareSecret({ scopeType: "env", scopeId: "env-staging", name: "API_KEY", value: "env-api-key" });
service.declareSecret({ scopeType: "org", scopeId: "org-acme", name: "DB_URL", value: "org-db" });
service.declareSecret({ scopeType: "project", scopeId: "proj-shop", name: "DB_URL", value: "proj-db" });
service.declareSecret({ scopeType: "org", scopeId: "org-acme", name: "REGION", value: "cn-north" });

const { environment, resolved } = service.createEnvironment({
  id: "env-staging",
  orgId: "org-acme",
  projectId: "proj-shop",
  name: "staging",
  requiredSecrets: ["API_KEY", "DB_URL", "REGION"],
});
console.log("resolved at creation (nearest scope wins, per key):");
for (const r of resolved) {
  console.log(`  ${r.name.padEnd(8)} level=${r.level.padEnd(8)} source=${r.sourcePath} fp=${r.fingerprint}`);
}

service.declareSecret({ scopeType: "org", scopeId: "org-acme", name: "REGION", value: "cn-south" });
console.log("after org REGION updated to cn-south, existing env still sees:");
console.log(" ", service.getEnvironmentSecrets(environment.id));

try {
  service.deleteDeclaration("org", "org-acme", "REGION");
} catch (err) {
  console.log("delete referenced declaration rejected:", (err as Error).message);
}

service.deleteEnvironment(environment.id);
service.deleteDeclaration("org", "org-acme", "REGION");
console.log("environment deleted -> snapshots cascaded, declaration now deletable. OK");
store.close();
