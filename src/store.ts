// State adapter boundary. The kernel depends only on this interface;
// the SQLite implementation lives in sqliteStore.ts.

import type { Lease, LeaseHistoryFilter, LeaseStatus } from "./contracts.ts";

export interface LeaseStore {
  insert(lease: Lease): void;
  update(lease: Lease): void;
  getById(leaseId: string): Lease | null;
  activeByPort(port: number): Lease | null;
  listActive(): Lease[];
  query(filter: LeaseHistoryFilter): Lease[];
  all(): Lease[];
  close(): void;
}

