import { DatabaseSync } from "node:sqlite";
import { conflictError, internalError, resourceError } from "../contract/errors.ts";
import type {
  Effect,
  PolicyDocument,
  PolicyRule,
  PolicySnapshot,
  RoleEdge,
} from "../contract/types.ts";

const MAX_RULES = 100_000;
const MAX_ROLES = 50_000;

/**
 * SQLite-backed policy store built on the synchronous node:sqlite driver.
 * Every read or write runs inside an IMMEDIATE transaction, so concurrent
 * callers always observe either the complete pre-update or post-update
 * state, never an intermediate one. Each committed mutation bumps a
 * monotonic version counter.
 */
export class PolicyStore {
  private readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS role_edges (
        role TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
        parent TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
        PRIMARY KEY (role, parent)
      );
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
        effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
        resource TEXT NOT NULL,
        action TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 0);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside an IMMEDIATE transaction; rolls back on any error. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackErr) {
        throw internalError(
          "TX_ROLLBACK_FAILED",
          `transaction failed and rollback also failed: ${String(rollbackErr)}`,
        );
      }
      throw err;
    }
  }

  private bumpVersion(): number {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'version'").run();
    return this.currentVersion();
  }

  private currentVersion(): number {
    const row = this.db.prepare("SELECT value AS v FROM meta WHERE key = 'version'").get() as { v: number };
    return Number(row.v);
  }

  /** Read a consistent, immutable snapshot inside a single transaction. */
  getSnapshot(): PolicySnapshot {
    return this.tx(() => {
      const version = this.currentVersion();
      const edges = this.db
        .prepare("SELECT role, parent FROM role_edges")
        .all() as unknown as RoleEdge[];
      const roles = new Map<string, string[]>();
      for (const { name } of this.db.prepare("SELECT name FROM roles").all() as unknown as { name: string }[]) {
        roles.set(name, []);
      }
      for (const e of edges) {
        roles.get(e.role)!.push(e.parent);
      }
      const rules = this.db
        .prepare("SELECT id, role, effect, resource, action FROM rules ORDER BY id")
        .all() as unknown as PolicyRule[];
      return { version, roles, rules };
    });
  }

  /** Atomically replace the entire policy. */
  replacePolicy(doc: PolicyDocument): number {
    return this.tx(() => {
      const roleNames = new Set<string>();
      for (const e of doc.roles) {
        roleNames.add(e.role);
        roleNames.add(e.parent);
      }
      for (const r of doc.rules) roleNames.add(r.role);
      if (roleNames.size > MAX_ROLES) {
        throw resourceError("ROLE_LIMIT", `policy declares more than ${MAX_ROLES} roles`);
      }
      if (doc.rules.length > MAX_RULES) {
        throw resourceError("RULE_LIMIT", `policy declares more than ${MAX_RULES} rules`);
      }
      this.assertAcyclic([...doc.roles]);
      this.db.exec("DELETE FROM rules; DELETE FROM role_edges; DELETE FROM roles;");
      const insRole = this.db.prepare("INSERT INTO roles (name) VALUES (?)");
      for (const name of roleNames) insRole.run(name);
      const insEdge = this.db.prepare("INSERT INTO role_edges (role, parent) VALUES (?, ?)");
      for (const e of doc.roles) insEdge.run(e.role, e.parent);
      const insRule = this.db.prepare(
        "INSERT INTO rules (role, effect, resource, action) VALUES (?, ?, ?, ?)",
      );
      for (const r of doc.rules) insRule.run(r.role, r.effect, r.resource, r.action);
      return this.bumpVersion();
    });
  }

  addRole(name: string): number {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT 1 AS x FROM roles WHERE name = ?").get(name);
      if (existing) throw conflictError("ROLE_EXISTS", `role "${name}" already exists`);
      this.db.prepare("INSERT INTO roles (name) VALUES (?)").run(name);
      return this.bumpVersion();
    });
  }

  deleteRole(name: string): number {
    return this.tx(() => {
      const res = this.db.prepare("DELETE FROM roles WHERE name = ?").run(name);
      if (Number(res.changes) === 0) throw conflictError("ROLE_NOT_FOUND", `role "${name}" does not exist`);
      return this.bumpVersion();
    });
  }

  addRoleEdge(edge: RoleEdge): number {
    return this.tx(() => {
      for (const name of [edge.role, edge.parent]) {
        const found = this.db.prepare("SELECT 1 AS x FROM roles WHERE name = ?").get(name);
        if (!found) throw conflictError("ROLE_NOT_FOUND", `role "${name}" does not exist`);
      }
      const dup = this.db
        .prepare("SELECT 1 AS x FROM role_edges WHERE role = ? AND parent = ?")
        .get(edge.role, edge.parent);
      if (dup) throw conflictError("EDGE_EXISTS", `edge ${edge.role} -> ${edge.parent} already exists`);
      const edges = this.db.prepare("SELECT role, parent FROM role_edges").all() as unknown as RoleEdge[];
      this.assertAcyclic([...edges, edge]);
      this.db.prepare("INSERT INTO role_edges (role, parent) VALUES (?, ?)").run(edge.role, edge.parent);
      return this.bumpVersion();
    });
  }

  addRule(rule: { role: string; effect: Effect; resource: string; action: string }): { id: number; version: number } {
    return this.tx(() => {
      const found = this.db.prepare("SELECT 1 AS x FROM roles WHERE name = ?").get(rule.role);
      if (!found) throw conflictError("ROLE_NOT_FOUND", `role "${rule.role}" does not exist`);
      const count = Number((this.db.prepare("SELECT COUNT(*) AS c FROM rules").get() as { c: number }).c);
      if (count >= MAX_RULES) throw resourceError("RULE_LIMIT", `rule limit ${MAX_RULES} reached`);
      const res = this.db
        .prepare("INSERT INTO rules (role, effect, resource, action) VALUES (?, ?, ?, ?)")
        .run(rule.role, rule.effect, rule.resource, rule.action);
      return { id: Number(res.lastInsertRowid), version: this.bumpVersion() };
    });
  }

  deleteRule(id: number): number {
    return this.tx(() => {
      const res = this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
      if (Number(res.changes) === 0) throw conflictError("RULE_NOT_FOUND", `rule id ${id} does not exist`);
      return this.bumpVersion();
    });
  }

  /** Detect cycles in a proposed edge set (iterative DFS over role -> parents). */
  private assertAcyclic(edges: RoleEdge[]): void {
    const parents = new Map<string, string[]>();
    for (const e of edges) {
      const list = parents.get(e.role) ?? [];
      list.push(e.parent);
      parents.set(e.role, list);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const root of parents.keys()) {
      if ((color.get(root) ?? WHITE) !== WHITE) continue;
      const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
      color.set(root, GRAY);
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const children = parents.get(top.node) ?? [];
        if (top.next < children.length) {
          const child = children[top.next]!;
          top.next += 1;
          const c = color.get(child) ?? WHITE;
          if (c === GRAY) {
            throw conflictError(
              "INHERITANCE_CYCLE",
              `adding this edge creates an inheritance cycle at role "${child}"`,
            );
          }
          if (c === WHITE) {
            color.set(child, GRAY);
            stack.push({ node: child, next: 0 });
          }
        } else {
          color.set(top.node, BLACK);
          stack.pop();
        }
      }
    }
  }
}
