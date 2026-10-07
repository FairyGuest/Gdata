import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import { BuildService } from '../src/service/buildService.ts';

export const FIXTURE_TARGETS = [
  { name: 'lib', paths: ['src/lib.ts'], deps: [] },
  { name: 'app', paths: ['src/app.ts'], deps: ['lib'] },
  { name: 'docs', paths: ['docs/readme.md'], deps: [] },
  { name: 'extra', paths: ['src/extra.ts'], deps: ['lib', 'docs'] },
];

export function writeWorkspaceFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function seedWorkspace(root: string): void {
  writeWorkspaceFile(root, 'src/lib.ts', 'export const lib = 1;');
  writeWorkspaceFile(root, 'src/app.ts', 'import { lib } from "./lib";');
  writeWorkspaceFile(root, 'src/extra.ts', 'export const extra = 1;');
  writeWorkspaceFile(root, 'docs/readme.md', '# docs');
}

export function makeService(overrides: Partial<AppConfig> = {}): { service: BuildService; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bw-test-'));
  seedWorkspace(root);
  const config = loadConfig({ dbPath: ':memory:', workspaceRoot: root, buildDelayMs: 0, ...overrides });
  const service = new BuildService(config);
  return { service, root };
}

export function makeRegistered(overrides: Partial<AppConfig> = {}): { service: BuildService; root: string } {
  const ctx = makeService(overrides);
  ctx.service.registerTargets(FIXTURE_TARGETS.map((t) => ({ ...t })));
  return ctx;
}