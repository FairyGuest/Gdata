import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { VaultConfig } from './kernel.js';

export interface ServiceConfig extends VaultConfig {
  dbPath: string;
  keyHex: string;
  keyId?: string;
  host: string;
  port: number;
  useVirtualClock: boolean;
  clockStartMs: number;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  dbPath: 'data/vault.db',
  keyHex: randomBytes(32).toString('hex'),
  host: '127.0.0.1',
  port: 8787,
  gracePeriodMs: 60_000,
  maxValueBytes: 16 * 1024,
  maxVersionsPerSecret: 1000,
  useVirtualClock: false,
  clockStartMs: 1_700_000_000_000,
};

export function loadConfig(path?: string): ServiceConfig {
  if (!path) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceConfig>;
  return { ...DEFAULT_CONFIG, ...raw };
}
