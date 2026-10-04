import type { Clock } from "./clock.ts";
import type { AesGcmCipher } from "./crypto.ts";
import { VaultError } from "./errors.ts";
import type { SqliteStore, VersionRow } from "./store.ts";

export interface VaultDeps {
  store: SqliteStore;
  cipher: AesGcmCipher;
  clock: Clock;
  /** rotation grace period in milliseconds */
  gracePeriodMs: number;
  /** run identifier stamped on every audit row and log line */
  runId: string;
}

export interface PutResult {
  name: string;
  version: number;
}

export interface GetResult {
  name: string;
  version: number;
  value: string;
  createdAt: number;
  graceUntil: number | null;
}

export interface RotateResult {
  name: string;
  version: number;
  graceUntil: number;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new VaultError("VALIDATION_ERROR", "secret name must match " + NAME_RE.source, { name });
  }
  return name;
}

function validateValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VaultError("VALIDATION_ERROR", "value must be a non-empty string");
  }
  if (value.length > 64 * 1024) {
    throw new VaultError("VALIDATION_ERROR", "value exceeds 64 KiB limit");
  }
  return value;
}

/**
 * Execution kernel. Orchestrates validation, crypto, state transitions and
 * audit. Every read/write produces exactly one audit row committed in the
 * same transaction as the business effect.
 *
 * Grace semantics: a superseded version is readable while now < graceUntil;
 * at now >= graceUntil reads fail with VERSION_EXPIRED.
 */
export class VaultCore {
  constructor(private readonly deps: VaultDeps) {}

  putSecret(nameRaw: unknown, valueRaw: unknown, actor = "anonymous"): PutResult {
    const name = validateName(nameRaw);
    const value = validateValue(valueRaw);
    const now = this.deps.clock.nowMs();
    const payload = this.deps.cipher.encrypt(value);
    const version = this.deps.store.putVersion(name, payload, now, {
      runId: this.deps.runId,
      ts: now,
      actor,
      action: "put",
      name,
      result: "success",
      errorCode: null,
      detail: null,
    });
    return { name, version };
  }

  getSecret(nameRaw: unknown, versionRaw?: unknown, actor = "anonymous"): GetResult {
    const name = validateName(nameRaw);
    let version: number | null = null;
    if (versionRaw !== undefined && versionRaw !== null) {
      const n = Number(versionRaw);
      if (!Number.isInteger(n) || n < 1) {
        throw new VaultError("VALIDATION_ERROR", "version must be a positive integer", { version: versionRaw });
      }
      version = n;
    }
    const now = this.deps.clock.nowMs();
    const auditBase = { runId: this.deps.runId, ts: now, actor, action: "get", name };

    if (this.deps.store.latestVersionNumber(name) === null) {
      const err = new VaultError("SECRET_NOT_FOUND", `secret '${name}' not found`);
      this.deps.store.recordAudit({ ...auditBase, version, result: "failure", errorCode: err.code, detail: err.message });
      throw err;
    }

    let decided: VaultError | null = null;
    const row = this.deps.store.getVersionAudited(name, version, auditBase, (r: VersionRow | null) => {
      if (!r) {
        decided = new VaultError("VERSION_NOT_FOUND", `version ${version} of '${name}' not found`);
      } else if (r.graceUntil !== null && now >= r.graceUntil) {
        decided = new VaultError("VERSION_EXPIRED", `version ${r.version} of '${name}' expired at ${r.graceUntil}`, {
          graceUntil: r.graceUntil,
          now,
        });
      }
      return decided
        ? { result: "failure" as const, errorCode: decided.code, detail: decided.message }
        : { result: "success" as const, errorCode: null, detail: null };
    });
    if (decided) throw decided;
    const value = this.deps.cipher.decrypt(row!);
    return { name, version: row!.version, value, createdAt: row!.createdAt, graceUntil: row!.graceUntil };
  }

  rotateSecret(nameRaw: unknown, actor = "anonymous"): RotateResult {
    const name = validateName(nameRaw);
    const now = this.deps.clock.nowMs();
    const latest = this.deps.store.latestVersionNumber(name);
    if (latest === null) {
      const err = new VaultError("SECRET_NOT_FOUND", `secret '${name}' not found`);
      this.deps.store.recordAudit({
        runId: this.deps.runId,
        ts: now,
        actor,
        action: "rotate",
        name,
        version: null,
        result: "failure",
        errorCode: err.code,
        detail: err.message,
      });
      throw err;
    }
    // re-encrypt the current plaintext under a fresh IV as the new version
    const current = this.deps.store.getVersionAudited(name, latest, {
      runId: this.deps.runId,
      ts: now,
      actor,
      action: "rotate-read",
      name,
    }, () => ({ result: "success" as const, errorCode: null, detail: null }));
    if (!current) throw new VaultError("CONFLICT", `no readable version for '${name}'`);
    const plaintext = this.deps.cipher.decrypt(current);
    const payload = this.deps.cipher.encrypt(plaintext);
    const graceUntil = now + this.deps.gracePeriodMs;
    const version = this.deps.store.rotate(name, payload, now, graceUntil, {
      runId: this.deps.runId,
      ts: now,
      actor,
      action: "rotate",
      name,
      result: "success",
      errorCode: null,
      detail: `graceUntil=${graceUntil}`,
    });
    return { name, version, graceUntil };
  }

  listVersions(nameRaw: unknown) {
    const name = validateName(nameRaw);
    if (this.deps.store.latestVersionNumber(name) === null) {
      throw new VaultError("SECRET_NOT_FOUND", `secret '${name}' not found`);
    }
    return this.deps.store.listVersions(name);
  }

  audit(name?: string) {
    return this.deps.store.listAudit(name);
  }
}
