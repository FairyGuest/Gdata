// Configuration layer: defaults < config file < environment variables.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EngineConfig } from '../contracts/types.ts';
import { EngineError } from '../contracts/errors.ts';

export const DEFAULT_CONFIG: EngineConfig = {
  port: 3939,
  host: '127.0.0.1',
  dbPath: 'data/lint-engine.db',
  logDir: 'logs',
  limits: {
    maxSourceBytes: 512 * 1024,
    maxFilesPerCheck: 200,
    maxMatchesPerRule: 1000,
    maxRules: 500,
  },
};

export function loadConfig(configPath = 'config/engine.config.json'): EngineConfig {
  let fileCfg: Partial<EngineConfig> = {};
  const abs = resolve(configPath);
  if (existsSync(abs)) {
    try {
      fileCfg = JSON.parse(readFileSync(abs, 'utf8')) as Partial<EngineConfig>;
    } catch (err) {
      throw new EngineError('INPUT_ERROR', `config file ${configPath} is not valid JSON`, String(err));
    }
  }
  const cfg: EngineConfig = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
    limits: { ...DEFAULT_CONFIG.limits, ...(fileCfg.limits ?? {}) },
  };
  if (process.env.LINT_ENGINE_PORT) cfg.port = Number(process.env.LINT_ENGINE_PORT);
  if (process.env.LINT_ENGINE_DB) cfg.dbPath = process.env.LINT_ENGINE_DB;
  if (process.env.LINT_ENGINE_LOG_DIR) cfg.logDir = process.env.LINT_ENGINE_LOG_DIR;
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new EngineError('INPUT_ERROR', `invalid port: ${cfg.port}`);
  }
  return cfg;
}
