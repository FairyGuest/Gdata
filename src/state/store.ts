import { DatabaseSync } from "node:sqlite";
import { resourceExhausted, stateConflict } from "../contract/errors.ts";
import type { Policy, Role, Snapshot } from "../contract/types.ts";
import { wouldCycle } from "../core/inheritance.ts";

export interface StoreLimits {
  maxRoles: number;
  maxPolicies: number;
}

// SQLite-backed state adapter. All mutations run inside IMMEDIATE
// transactions; snapshot reads run inside a single transaction so concurrent
// readers always observe either the full pre-update or post-update state,
// never an intermediate one. node:sqlite is synchronous, which additionally
// serializes all access on the event loop.
export class PolicyStore {
  private db: DatabaseSync;

  private limits: StoreLimits;

  constructor(dbPath: string, limits: StoreLimits) {
    this.limits = limits;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY,
        inherits TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow','deny'))
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES ('version', 0);
    `);
  }

  close(): void {
    this.db.close();
  }

  private bumpVersion(): void {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'version'").run();
  }

  // Reads a consistent snapshot. When called inside an open mutation
  // transaction it reuses that transaction instead of nesting.
  snapshot(): Snapshot {
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec("BEGIN");
    try {
      const version = (this.db
        .prepare("SELECT value AS v FROM meta WHERE key = 'version'")
        .get() as { v: number }).v;
      const roles = (this.db
        .prepare("SELECT name, inherits FROM roles")
        .all() as Array<{ name: string; inherits: string }>)
        .map((r) => ({ name: r.name, inherits: JSON.parse(r.inherits) as string[] }));
      const policies = this.db
        .prepare("SELECT id, role, resource, action, effect FROM policies")
        .all() as unknown as Policy[];
      if (!nested) this.db.exec("COMMIT");
      return { version, roles, policies };
    } catch (err) {
      if (!nested) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private rolesByName(): Map<string, Role> {
    return new Map(this.snapshot().roles.map((r) => [r.name, r]));
  }

  upsertRole(name: string, inherits: string[]): Role {
    return this.inTransaction(() => {
      const existing = this.db.prepare("SELECT inherits FROM roles WHERE name = ?").get(name);
      if (!existing) {
        const count = (this.db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number }).c;
        if (count >= this.limits.maxRoles) {
          throw resourceExhausted("role limit reached", { maxRoles: this.limits.maxRoles });
        }
      }
      const byName = this.rolesByName();
      for (const parent of inherits) {
        if (!byName.has(parent)) {
          throw stateConflict(`cannot inherit unknown role '${parent}'`, { parent });
        }
        if (wouldCycle(name, parent, byName)) {
          throw stateConflict("inheritance would create a cycle", { role: name, parent });
        }
      }
      const deduped = [...new Set(inherits)];
      this.db
        .prepare("INSERT INTO roles(name, inherits) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET inherits = excluded.inherits")
        .run(name, JSON.stringify(deduped));
      this.bumpVersion();
      return { name, inherits: deduped };
    });
  }

  deleteRole(name: string): boolean {
    return this.inTransaction(() => {
      const used = this.db.prepare("SELECT id FROM policies WHERE role = ? LIMIT 1").get(name);
      if (used) throw stateConflict(`role '${name}' still referenced by policies`, { name });
      const inherited = this.snapshot().roles.filter((r) => r.inherits.includes(name));
      if (inherited.length > 0) {
        throw stateConflict(`role '${name}' still inherited by other roles`, {
          name,
          inheritedBy: inherited.map((r) => r.name),
        });
      }
      const res = this.db.prepare("DELETE FROM roles WHERE name = ?").run(name);
      if (Number(res.changes) > 0) this.bumpVersion();
      return Number(res.changes) > 0;
    });
  }

  putPolicy(policy: Policy): Policy {
    return this.inTransaction(() => {
      const existing = this.db.prepare("SELECT id FROM policies WHERE id = ?").get(policy.id);
      if (!existing) {
        const count = (this.db.prepare("SELECT COUNT(*) AS c FROM policies").get() as { c: number }).c;
        if (count >= this.limits.maxPolicies) {
          throw resourceExhausted("policy limit reached", { maxPolicies: this.limits.maxPolicies });
        }
      }
      if (!this.db.prepare("SELECT name FROM roles WHERE name = ?").get(policy.role)) {
        throw stateConflict(`policy references unknown role '${policy.role}'`, { role: policy.role });
      }
      this.db
        .prepare("INSERT INTO policies(id, role, resource, action, effect) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role=excluded.role, resource=excluded.resource, action=excluded.action, effect=excluded.effect")
        .run(policy.id, policy.role, policy.resource, policy.action, policy.effect);
      this.bumpVersion();
      return policy;
    });
  }

  deletePolicy(id: string): boolean {
    return this.inTransaction(() => {
      const res = this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);
      if (Number(res.changes) > 0) this.bumpVersion();
      return Number(res.changes) > 0;
    });
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

