import { loadConfig } from "./config";
import { SqliteAuditStore } from "./state/sqliteStore";
import { AuditService } from "./service/auditService";
import { buildServer } from "./http/server";

async function main() {
  const config = loadConfig();
  const store = new SqliteAuditStore(config.dbPath);
  const service = new AuditService(store, config);
  const app = buildServer(service);
  await app.listen({ port: config.port, host: config.host });
  console.log(
    "audit-chain listening on http://" + config.host + ":" + config.port +
      " (db: " + config.dbPath + ")"
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

