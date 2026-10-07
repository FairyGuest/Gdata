import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type InstanceState = 'pending' | 'provisioning' | 'ready' | 'suspended' | 'deleted';

export interface InstanceRow {
  id: number;
  name: string;
  template: string;
  state: InstanceState;
  cpu: number;
  memory_mb: number;
  run_counter: number;
  last_ready_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TransitionRow {
  id: number;
  instance_id: number;
  run_id: number;
  from_state: string;
  to_state: string;
  reason: string;
  at: number;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      name TEXT PRIMARY KEY,
      image TEXT NOT NULL,
      features TEXT NOT NULL,
      cpu REAL NOT NULL,
      memory_mb REAL NOT NULL,
      idle_timeout_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      state TEXT NOT NULL,
      cpu REAL NOT NULL,
      memory_mb REAL NOT NULL,
      run_counter INTEGER NOT NULL DEFAULT 0,
      last_ready_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instances_name ON instances(name);
    CREATE INDEX IF NOT EXISTS idx_instances_state ON instances(state);
    CREATE TABLE IF NOT EXISTS transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transitions_instance ON transitions(instance_id);
  `);
  return db;
}
