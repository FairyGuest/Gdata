import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition } from '../src/domain/validate.ts';
import { DomainError, type ValidationIssue } from '../src/domain/errors.ts';
import { loadFixture, svc } from './helpers.ts';

function issuesOf(fn: () => unknown): ValidationIssue[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DomainError, 'expected DomainError');
    assert.equal(err.category, 'INPUT_ERROR');
    return (err.details as { issues: ValidationIssue[] }).issues;
  }
  assert.fail('expected validation to throw');
}

test('valid fixture passes validation', () => {
  const def = validateDefinition(loadFixture());
  assert.equal(def.services.length, 5);
});

test('dependency cycle is rejected with the cycle path', () => {
  const def = {
    name: 'cyc',
    services: [
      svc({ name: 'alpha', dependsOn: ['gamma'] }),
      svc({ name: 'beta', dependsOn: ['alpha'] }),
      svc({ name: 'gamma', dependsOn: ['beta'] }),
    ],
  };
  const issues = issuesOf(() => validateDefinition(def));
  const cycle = issues.find((i) => i.code === 'CYCLE');
  assert.ok(cycle, 'expected a CYCLE issue');
  const path = (cycle.details as { cycle: string[] }).cycle;
  assert.deepEqual(path, ['alpha', 'gamma', 'beta', 'alpha']);
});

test('port conflict is rejected with port and both service names', () => {
  const def = {
    name: 'ports',
    services: [
      svc({ name: 'web', ports: [8080] }),
      svc({ name: 'admin', ports: [8080] }),
    ],
  };
  const issues = issuesOf(() => validateDefinition(def));
  const conflict = issues.find((i) => i.code === 'PORT_CONFLICT');
  assert.ok(conflict, 'expected a PORT_CONFLICT issue');
  assert.deepEqual(conflict.details, { port: 8080, services: ['web', 'admin'] });
});

test('env reference to undeclared output key is rejected', () => {
  const def = {
    name: 'envs',
    services: [
      svc({ name: 'db', outputs: ['DSN'] }),
      svc({ name: 'api', dependsOn: ['db'], env: { DATABASE_URL: '${db.PASSWORD}' } }),
    ],
  };
  const issues = issuesOf(() => validateDefinition(def));
  const env = issues.find((i) => i.code === 'ENV_UNRESOLVED');
  assert.ok(env, 'expected an ENV_UNRESOLVED issue');
  assert.match(env.message, /PASSWORD/);
  assert.match(env.message, /api/);
});

test('env reference to unknown service is rejected', () => {
  const def = {
    name: 'envs2',
    services: [svc({ name: 'api', env: { X: '${ghost.KEY}' } })],
  };
  const issues = issuesOf(() => validateDefinition(def));
  assert.ok(issues.some((i) => i.code === 'ENV_UNRESOLVED'));
});

test('unknown dependency is rejected distinctly from cycles', () => {
  const def = {
    name: 'unk',
    services: [svc({ name: 'api', dependsOn: ['nope'] })],
  };
  const issues = issuesOf(() => validateDefinition(def));
  assert.ok(issues.some((i) => i.code === 'UNKNOWN_DEPENDENCY'));
  assert.ok(!issues.some((i) => i.code === 'CYCLE'));
});

test('schema violations are rejected', () => {
  const issues = issuesOf(() => validateDefinition({ name: 'bad', services: [{ name: 'x', ports: ['not-a-port'] }] }));
  assert.ok(issues.some((i) => i.code === 'SCHEMA'));
});
