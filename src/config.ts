import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidInput } from './contracts';

export interface RunnerConfig {
  port: number;
  host: string;
  dbPath: string;
  defaultPattern: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  /** 单用例超时上限，防止调用方传入离谱值 */
  maxTimeoutMs: number;
  /** 单次运行最多发现的测试文件数，超出报 RESOURCE_EXHAUSTED */
  maxFiles: number;
  /** 文件间依赖：key 文件依赖 value 列表中的文件（相对测试目录） */
  dependencies: Record<string, string[]>;
}

export const DEFAULT_CONFIG: RunnerConfig = {
  port: 8787,
  host: '127.0.0.1',
  dbPath: path.join('data', 'runs.sqlite'),
  defaultPattern: '*.test.js',
  defaultTimeoutMs: 5000,
  maxConcurrency: 8,
  maxTimeoutMs: 60000,
  maxFiles: 500,
  dependencies: {},
};

export function loadConfig(configPath?: string): RunnerConfig {
  const cfg: RunnerConfig = { ...DEFAULT_CONFIG };
  const file = configPath ?? process.env.RUNNER_CONFIG ?? 'runner.config.json';
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw invalidInput('配置文件 ' + file + ' 不是合法 JSON: ' + (e as Error).message);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalidInput('配置文件 ' + file + ' 必须是 JSON 对象');
    }
    Object.assign(cfg, parsed);
  }
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: RunnerConfig): void {
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw invalidInput('配置 port 非法: ' + cfg.port);
  }
  if (!Number.isInteger(cfg.defaultTimeoutMs) || cfg.defaultTimeoutMs <= 0) {
    throw invalidInput('配置 defaultTimeoutMs 必须为正整数');
  }
  if (!Number.isInteger(cfg.maxConcurrency) || cfg.maxConcurrency < 1) {
    throw invalidInput('配置 maxConcurrency 必须 >= 1');
  }
  if (!Number.isInteger(cfg.maxFiles) || cfg.maxFiles < 1) {
    throw invalidInput('配置 maxFiles 必须 >= 1');
  }
}