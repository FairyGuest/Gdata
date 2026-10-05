import type { JsonValue, SnapshotRecord } from "../contract/types.ts";

// State adapter contract. The engine depends only on this interface,
// so the SQLite adapter can be swapped without touching the kernel.
export interface SnapshotStore {
  get(name: string): SnapshotRecord | null;
  put(name: string, data: JsonValue): void;   // upsert
  count(): number;
  close(): void;
}
