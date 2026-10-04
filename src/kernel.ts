import { AuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { parseName, parseValue, parseVersion } from './contract.js';
import type { Cipher } from './crypto.js';
import { VaultError } from './errors.js';
import type { VaultStore } from './store.js';

export interface VaultConfig {
  gracePeriodMs: number;
  maxValueBytes: number;
  maxVersionsPerSecret: number;
}

export interface OpContext {
  runId?: string;
}

export interface WriteResult {
  name: string;
  version: number;
  keyId: string;
}

export interface ReadResult {
  name: string;
  version: number;
  value: string;
  keyId: string;
  expiresAt: number | null;
}

export interface RotateResult {
  name: string;
  currentVersion: number;
  expiredVersions: number;
  graceUntil: number;
}

export class VaultKernel {
  private readonly audit: AuditLog;

  constructor(
    private readonly store: VaultStore,
    private readonly cipher: Cipher,
    private readonly clock: Clock,
    private readonly config: VaultConfig,
  ) {
    this.audit = new AuditLog(store);
  }

  private aad(name: string, version: number): string {
    return 'vault:v1:' + name + ':' + version;
  }

  private record(
    op: string,
    name: string | null,
    version: number | null,
    result: 'OK' | 'ERROR',
    reason: string,
    ctx: OpContext,
    errorCode?: string,
  ): void {
    this.audit.append({
      ts: this.clock.now(),
      runId: ctx.runId ?? null,
      op,
      name,
      version,
      result,
      errorCode: errorCode ?? null,
      reason,
    });
  }

  private runAudited<T>(
    op: string,
    name: string | null,
    version: number | null,
    ctx: OpContext,
    reason: string,
    fn: () => T,
  ): T {
    try {
      return this.store.transaction(() => {
        const out = fn();
        this.record(op, name, version, 'OK', reason, ctx);
        return out;
      });
    } catch (err) {
      const code = err instanceof VaultError ? err.code : 'INTERNAL';
      // business writes rolled back; failure audit commits in its own transaction
      this.store.transaction(() =>
        this.record(op, name, version, 'ERROR', err instanceof Error ? err.message : String(err), ctx, code),
      );
      throw err;
    }
  }

  write(rawName: unknown, rawValue: unknown, ctx: OpContext = {}): WriteResult {
    const name = parseName(rawName);
    const value = parseValue(rawValue, this.config.maxValueBytes);
    return this.runAudited('write', name, null, ctx, 'encrypt+insert new version', () => {
      if (!this.store.secretExists(name)) this.store.createSecret(name, this.clock.now());
      const latest = this.store.latestVersion(name) ?? 0;
      if (latest >= this.config.maxVersionsPerSecret) {
        throw new VaultError('RESOURCE_EXHAUSTED', 'max versions per secret reached', {
          maxVersionsPerSecret: this.config.maxVersionsPerSecret,
        });
      }
      const version = latest + 1;
      const bundle = this.cipher.encrypt(Buffer.from(value, 'utf8'), this.aad(name, version));
      this.store.insertVersion({
        name,
        version,
        ciphertext: bundle.ciphertext,
        iv: bundle.iv,
        tag: bundle.tag,
        key_id: bundle.keyId,
        created_at: this.clock.now(),
        expires_at: null,
      });
      return { name, version, keyId: bundle.keyId };
    });
  }

  read(rawName: unknown, rawVersion?: unknown, ctx: OpContext = {}): ReadResult {
    const name = parseName(rawName);
    const version = parseVersion(rawVersion);
    return this.runAudited('read', name, version ?? null, ctx, 'decrypt version', () => {
      if (!this.store.secretExists(name)) {
        throw new VaultError('NOT_FOUND', "secret '" + name + "' does not exist");
      }
      const v = version ?? this.store.latestVersion(name);
      if (v === null) throw new VaultError('NOT_FOUND', "secret '" + name + "' has no versions");
      const row = this.store.getVersion(name, v);
      if (!row) {
        throw new VaultError('NOT_FOUND', "secret '" + name + "' version " + v + ' does not exist');
      }
      const now = this.clock.now();
      if (row.expires_at !== null && now >= row.expires_at) {
        throw new VaultError(
          'VERSION_EXPIRED',
          'version ' + v + " of '" + name + "' expired at " + row.expires_at + ' (now ' + now + ')',
          { expiresAt: row.expires_at, now },
        );
      }
      const plain = this.cipher.decrypt(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyId: row.key_id },
        this.aad(name, v),
      );
      return { name, version: v, value: plain.toString('utf8'), keyId: row.key_id, expiresAt: row.expires_at };
    });
  }

  rotate(rawName: unknown, ctx: OpContext = {}): RotateResult {
    const name = parseName(rawName);
    return this.runAudited(
      'rotate',
      name,
      null,
      ctx,
      'retire old versions with ' + this.config.gracePeriodMs + 'ms grace',
      () => {
        if (!this.store.secretExists(name)) {
          throw new VaultError('NOT_FOUND', "secret '" + name + "' does not exist");
        }
        const latest = this.store.latestVersion(name);
        if (latest === null) throw new VaultError('NOT_FOUND', "secret '" + name + "' has no versions");
        const graceUntil = this.clock.now() + this.config.gracePeriodMs;
        const expiredVersions = this.store.expireVersionsBefore(name, latest, graceUntil);
        return { name, currentVersion: latest, expiredVersions, graceUntil };
      },
    );
  }

  listVersions(rawName: unknown) {
    const name = parseName(rawName);
    if (!this.store.secretExists(name)) {
      throw new VaultError('NOT_FOUND', "secret '" + name + "' does not exist");
    }
    return this.store.listVersions(name);
  }

  auditLog(): AuditLog {
    return this.audit;
  }

  stats() {
    return {
      secrets: this.store.countSecrets(),
      versions: this.store.countVersions(),
      auditEntries: this.store.countAudit(),
      auditIntegrity: this.audit.verify(),
    };
  }
}
