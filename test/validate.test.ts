import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpec } from '../src/contract/parse.ts';
import { OrchestrationError } from '../src/contract/errors.ts';
import { validateSpec } from '../src/core/validate.ts';

const load = (name: string) =>
  parseSpec(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')));

function expectOrchestrationError(fn: () => void, code: string): OrchestrationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof OrchestrationError, `expected OrchestrationError, got ${err}`);
    assert.equal((err as OrchestrationError).code, code);
    return err as OrchestrationError;
  }
  assert.fail(`expected ${code} but no error was thrown`);
}

test('cycle detection rejects and names the cycle sequence', () => {
  const err = expectOrchestrationError(() => validateSpec(load('cycle.json')), 'VALIDATION_CYCLE');
  const details = err.details as { cycle: string[] };
  assert.deepEqual(details.cycle, ['a', 'c', 'b', 'a']);
  assert.match(err.message, /a -> c -> b -> a/);
});

test('port conflict rejects with port and both service names', () => {
  const err = expectOrchestrationError(() => validateSpec(load('port-conflict.json')), 'VALIDATION_PORT_CONFLICT');
  const details = err.details as { conflicts: { port: number; services: string[] }[] };
  assert.deepEqual(details.conflicts, [{ port: 9000, services: ['alpha', 'beta'] }]);
});

test('missing env output key rejects with key and referrer', () => {
  const err = expectOrchestrationError(() => validateSpec(load('missing-env.json')), 'VALIDATION_MISSING_ENV');
  const details = err.details as { missing: { key: string; referencedBy: string[] }[] };
  assert.deepEqual(details.missing, [{ key: 'MISSING_KEY', referencedBy: ['svc'] }]);
});

test('unknown dependency is rejected distinctly', () => {
  const spec = load('valid-multi-layer.json');
  spec.services[3].dependsOn = ['ghost'];
  const err = expectOrchestrationError(() => validateSpec(spec), 'VALIDATION_UNKNOWN_DEPENDENCY');
  const details = err.details as { unknownDependencies: { service: string; dependency: string }[] };
  assert.deepEqual(details.unknownDependencies, [{ service: 'worker', dependency: 'ghost' }]);
});

test('contract parse error on malformed spec', () => {
  const err = expectOrchestrationError(
    () => parseSpec({ name: 'x', services: [{ name: 's', port: 99999 }] }),
    'CONTRACT_PARSE_ERROR',
  );
  assert.match(err.message, /port/);
});
