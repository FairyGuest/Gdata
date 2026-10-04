import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { VaultError } from "./errors.ts";

export interface VaultConfig {
  port: number;
  host: string;
  dbPath: string;
  masterKeyHex: string;
  gracePeriodMs: number;
  runId: string;
}

/**
 * Configuration layer. Resolution order: explicit overrides > env vars >
 * local dev defaults. A missing master key is generated once and persisted
 * next to the database so local restarts keep data readable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<VaultConfig> = {}): VaultConfig {
  const dbPath = overrides.dbPath ?? env.VAULT_DB_PATH ?? "./data/vault.db";
  const gracePeriodMs = overrides.gracePeriodMs ?? Number(env.VAULT_GRACE_MS ?? 60_000);
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs <= 0) {
    throw new VaultError("VALIDATION_ERROR", "VAULT_GRACE_MS must be a positive number");
  }
  const masterKeyHex =
    overrides.masterKeyHex ?? env.VAULT_MASTER_KEY ?? loadOrCreateDevKey(dbPath);
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new VaultError("VALIDATION_ERROR", "master key must be 64 hex chars (32 bytes)");
  }
  return {
    port: overrides.port ?? Number(env.PORT ?? 8787),
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    dbPath,
    masterKeyHex,
    gracePeriodMs,
    runId: overrides.runId ?? env.VAULT_RUN_ID ?? `run-${randomUUID()}`,
  };
}

function loadOrCreateDevKey(dbPath: string): string {
  const keyPath = dbPath === ":memory:" ? null : dbPath + ".key";
  if (keyPath && existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  if (keyPath) {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, key, { mode: 0o600 });
  }
  return key;
}
