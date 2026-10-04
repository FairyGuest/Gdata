import { SqliteAuditStore } from "../src/state/sqliteStore";
import { AuditService } from "../src/service/auditService";
import { ServiceConfig } from "../src/config";

let runCounter = 0;

export function newRunId(): string {
  runCounter += 1;
  return "run-" + Date.now().toString(36) + "-" + runCounter;
}

export function tlog(
  runId: string,
  step: string,
  state: unknown,
  reason: string
): void {
  console.log(
    JSON.stringify({ runId, step, state, reason, at: new Date().toISOString() })
  );
}

export function makeService(overrides: Partial<ServiceConfig> = {}): {
  service: AuditService;
  store: SqliteAuditStore;
} {
  const config: ServiceConfig = {
    dbPath: ":memory:",
    port: 0,
    host: "127.0.0.1",
    maxPayloadBytes: 1024,
    maxEntries: 100,
    ...overrides,
  };
  const store = new SqliteAuditStore(config.dbPath);
  return { service: new AuditService(store, config), store };
}

