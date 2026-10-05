import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config/config.ts';
import { EngineError } from '../src/contracts/errors.ts';

test('missing config file falls back to defaults', () => {
  const cfg = loadConfig('config/does-not-exist.json');
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test('env overrides port', () => {
  process.env.LINT_ENGINE_PORT = '4555';
  try {
    assert.equal(loadConfig('config/does-not-exist.json').port, 4555);
  } finally {
    delete process.env.LINT_ENGINE_PORT;
  }
});

test('invalid config JSON is INPUT_ERROR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-cfg-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    assert.throws(() => loadConfig(bad), (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal((err as EngineError).category, 'INPUT_ERROR');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
