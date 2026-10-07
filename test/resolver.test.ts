// Pure resolution semantics. Reference answers are hardcoded literals,
// not derived from the implementation under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecrets, scopePathOf } from '../src/core/resolver.js';
import { Declaration } from '../src/contracts/types.js';

const envDecl = (name: string, value: string): Declaration => ({
  id: 'env-' + name,
  scopeLevel: 'env',
  org: 'acme',
  project: 'web',
  env: 'prod',
  name,
  value,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const projDecl = (name: string, value: string): Declaration => ({
  id: 'proj-' + name,
  scopeLevel: 'project',
  org: 'acme',
  project: 'web',
  env: null,
  name,
  value,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const orgDecl = (name: string, value: string): Declaration => ({
  id: 'org-' + name,
  scopeLevel: 'org',
  org: 'acme',
  project: null,
  env: null,
  name,
  value,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('nearest scope wins per key, decided independently', () => {
  const declarations = [
    orgDecl('API_TOKEN', 'org-token-v1'),
    projDecl('API_TOKEN', 'proj-token-v1'),
    envDecl('API_TOKEN', 'env-token-v1'),
    orgDecl('ORG_ONLY', 'org-only-secret'),
    projDecl('PROJ_ONLY', 'proj-only-secret'),
  ];
  const r = resolveSecrets(declarations, ['API_TOKEN', 'ORG_ONLY', 'PROJ_ONLY']);
  assert.deepEqual(r.missing, []);
  const byName = new Map(r.resolved.map((s) => [s.name, s]));
  assert.equal(byName.get('API_TOKEN')!.value, 'env-token-v1');
  assert.equal(byName.get('API_TOKEN')!.sourceLevel, 'env');
  assert.equal(byName.get('API_TOKEN')!.sourcePath, 'org:acme/project:web/env:prod');
  assert.equal(byName.get('ORG_ONLY')!.sourceLevel, 'org');
  assert.equal(byName.get('ORG_ONLY')!.sourcePath, 'org:acme');
  assert.equal(byName.get('PROJ_ONLY')!.sourceLevel, 'project');
  // decision log records the overridden lower scopes
  const decision = r.decisions.find((d) => d.name === 'API_TOKEN')!;
  assert.deepEqual(decision.overridden.map((o) => o.level), ['project', 'org']);
});

test('project overrides org when env-level is absent', () => {
  const r = resolveSecrets([orgDecl('K', 'org-token-v1'), projDecl('K', 'proj-token-v1')], ['K']);
  assert.equal(r.resolved[0]!.value, 'proj-token-v1');
  assert.equal(r.resolved[0]!.sourceLevel, 'project');
});

test('undeclared names are reported individually', () => {
  const r = resolveSecrets([orgDecl('KNOWN', 'org-only-secret')], ['KNOWN', 'GHOST_A', 'GHOST_B']);
  assert.deepEqual(r.missing, ['GHOST_A', 'GHOST_B']);
  assert.equal(r.resolved.length, 1);
});

test('scopePathOf renders the declaration source path', () => {
  assert.equal(scopePathOf(orgDecl('X', 'v')), 'org:acme');
  assert.equal(scopePathOf(projDecl('X', 'v')), 'org:acme/project:web');
  assert.equal(scopePathOf(envDecl('X', 'v')), 'org:acme/project:web/env:prod');
});

