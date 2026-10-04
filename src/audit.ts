import { createHash } from 'node:crypto';
import type { AuditInsert, AuditRow, VaultStore } from './store.js';

export function computeAuditHash(prevHash: string, entry: AuditInsert): string {
  const h = createHash('sha256');
  h.update(prevHash);
  h.update('|');
  h.update(String(entry.ts));
  h.update('|');
  h.update(entry.runId ?? '');
  h.update('|');
  h.update(entry.op);
  h.update('|');
  h.update(entry.name ?? '');
  h.update('|');
  h.update(entry.version === null ? '' : String(entry.version));
  h.update('|');
  h.update(entry.result);
  h.update('|');
  h.update(entry.errorCode ?? '');
  h.update('|');
  h.update(entry.reason);
  return h.digest('hex');
}

export class AuditLog {
  constructor(private readonly store: VaultStore) {}

  append(entry: AuditInsert): number {
    const prevHash = this.store.lastAuditHash();
    const hash = computeAuditHash(prevHash, entry);
    return this.store.insertAudit(entry, prevHash, hash);
  }

  list(name?: string): AuditRow[] {
    return this.store.listAudit(name);
  }

  verify(): { ok: boolean; entries: number; brokenAtId?: number; reason?: string } {
    const rows = this.store.listAudit();
    let prevHash = 'GENESIS';
    for (const row of rows) {
      const entry: AuditInsert = {
        ts: row.ts,
        runId: row.runId,
        op: row.op,
        name: row.name,
        version: row.version,
        result: row.result,
        errorCode: row.errorCode,
        reason: row.reason,
      };
      const expected = computeAuditHash(prevHash, entry);
      if (row.prevHash !== prevHash || row.hash !== expected) {
        return { ok: false, entries: rows.length, brokenAtId: row.id, reason: 'hash chain mismatch' };
      }
      prevHash = row.hash;
    }
    return { ok: true, entries: rows.length };
  }
}
