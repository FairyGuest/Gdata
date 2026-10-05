// Config layer: defaults <- JSON file <- env overrides. Validated against contracts.
import { readFileSync, existsSync } from 'node:fs';
import { ChaosError, type FaultConfig, type FaultType, FAULT_TYPES } from './contracts.ts';

export interface ServiceConfig {
  /** port of the chaos proxy (the port clients call) */
  proxyPort: number;
  /** port of the diagnostics/admin API (same server in this build) */
  targetUrl: string;
  /** sqlite file path, ':memory:' allowed */
  dbPath: string;
  /** faults active at boot */
  initialFaults: Partial<Record<FaultType, FaultConfig>>;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  proxyPort: 8400,
  targetUrl: 'http://127.0.0.1:8500',
  dbPath: 'chaos.db',
  initialFaults: {},
};

export function validateFaultConfig(type: FaultType, raw: unknown): FaultConfig {
  if (typeof raw !== 'object' || raw === null) throw ChaosError.invalidConfig(`fault ${type}: config must be an object`);
  const c = raw as Record<string, unknown>;
  const probability = c.probability === undefined ? 1 : Number(c.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw ChaosError.invalidConfig(`fault ${type}: probability must be in [0,1], got ${String(c.probability)}`);
  const durationMs = c.durationMs === undefined ? undefined : Number(c.durationMs);
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0))
    throw ChaosError.invalidConfig(`fault ${type}: durationMs must be > 0`);
  const p = (c.params ?? {}) as Record<string, unknown>;
  const params: FaultConfig['params'] = {};
  if (type === 'latency') {
    params.delayMs = p.delayMs === undefined ? 200 : Number(p.delayMs);
    if (!Number.isFinite(params.delayMs) || params.delayMs < 0)
      throw ChaosError.invalidConfig('latency: params.delayMs must be >= 0');
  }
  if (type === 'errorStatus') {
    params.statusCode = p.statusCode === undefined ? 500 : Number(p.statusCode);
    if (!Number.isInteger(params.statusCode) || params.statusCode < 400 || params.statusCode > 599)
      throw ChaosError.invalidConfig('errorStatus: params.statusCode must be an integer in [400,599]');
  }
  if (type === 'truncate') {
    params.keepRatio = p.keepRatio === undefined ? 0.3 : Number(p.keepRatio);
    if (!Number.isFinite(params.keepRatio) || params.keepRatio <= 0 || params.keepRatio >= 1)
      throw ChaosError.invalidConfig('truncate: params.keepRatio must be in (0,1)');
  }
  return { probability, durationMs, params };
}

export function loadConfig(path = process.env.CHAOS_CONFIG ?? 'config/chaos.config.json'): ServiceConfig {
  let fileCfg: Partial<ServiceConfig> = {};
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceConfig>;
    } catch (e) {
      throw ChaosError.invalidConfig(`config file ${path}: ${(e as Error).message}`);
    }
  }
  const cfg: ServiceConfig = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
    proxyPort: Number(process.env.CHAOS_PROXY_PORT ?? fileCfg.proxyPort ?? DEFAULT_CONFIG.proxyPort),
    targetUrl: process.env.CHAOS_TARGET_URL ?? fileCfg.targetUrl ?? DEFAULT_CONFIG.targetUrl,
    dbPath: process.env.CHAOS_DB_PATH ?? fileCfg.dbPath ?? DEFAULT_CONFIG.dbPath,
    initialFaults: fileCfg.initialFaults ?? {},
  };
  if (!Number.isInteger(cfg.proxyPort) || cfg.proxyPort <= 0 || cfg.proxyPort > 65535)
    throw ChaosError.invalidConfig(`proxyPort invalid: ${cfg.proxyPort}`);
  try { new URL(cfg.targetUrl); } catch { throw ChaosError.invalidConfig(`targetUrl invalid: ${cfg.targetUrl}`); }
  for (const t of Object.keys(cfg.initialFaults)) {
    if (!FAULT_TYPES.includes(t as FaultType)) throw ChaosError.invalidConfig(`unknown fault type in initialFaults: ${t}`);
    cfg.initialFaults[t as FaultType] = validateFaultConfig(t as FaultType, cfg.initialFaults[t as FaultType]);
  }
  return cfg;
}
