// Kernel semantics against a real (in-memory) SQLite store.
// Expected fingerprints are hardcoded sha256 prefixes computed independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../src/state/store.js';
import { SecretService } from '../src/core/service.js';
import { ServiceError } from '../src/contracts/types.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';

function makeService() {
  const store = new SecretStore(':memory:');
  const config = loadConfig({ ...process.env, ESB_LOG_FILE: '' });
  const logger = createLogger(null, 'test-run');
  const service = new SecretService(store, { ...config, fingerprintLength: 12 }, logger);
  return { store, service };
}

function seedThreeLevels(service: SecretService) {
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  service.upsertDeclaration({ level: 'project', org: 'acme', project: 'web' }, 'API_TOKEN', 'proj-token-v1');
  service.upsertDeclaration({ level: 'env', org: 'acme', project: 'web', env: 'prod' }, 'API_TOKEN', 'env-token-v1');
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'ORG_ONLY', 'org-only-secret');
  service.upsertDeclaration({ level: 'project', org: 'acme', project: 'web' }, 'PROJ_ONLY', 'proj-only-secret');
}

test('environment snapshot resolves nearest-scope winners with fingerprints', () => {
  const { service } = makeService();
  seedThreeLevels(service);
  const { secrets } = service.createEnvironment({
    org: 'acme', project: 'web', env: 'prod',
    required: ['API_TOKEN', 'ORG_ONLY', 'PROJ_ONLY'],
  });
  const byName = new Map(secrets.map((s) => [s.name, s]));
  assert.equal(byName.get('API_TOKEN')!.level, 'env');
  assert.equal(byName.get('API_TOKEN')!.fingerprint, 'b8f5e926903f'); // sha256('env-token-v1')[0:12]
  assert.equal(byName.get('ORG_ONLY')!.level, 'org');
  assert.equal(byName.get('ORG_ONLY')!.fingerprint, '3ab01d8ae5a7');
  assert.equal(byName.get('PROJ_ONLY')!.level, 'project');
  assert.equal(byName.get('PROJ_ONLY')!.fingerprint, '44af71be0e39');
});

test('snapshot isolation: later declaration updates do not touch existing environments', () => {
  const { service } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  const created = service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] });
  assert.equal(created.secrets[0]!.fingerprint, '222441c9b5e9'); // org-token-v1
  assert.equal(created.secrets[0]!.declarationVersion, 1);

  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v2');
  const after = service.listEnvironmentSecrets('acme', 'web', 'prod');
  assert.equal(after.secrets[0]!.fingerprint, '222441c9b5e9', 'old environment keeps creation-time value');
  assert.equal(after.secrets[0]!.declarationVersion, 1);

  const fresh = service.createEnvironment({ org: 'acme', project: 'web', env: 'staging', required: ['API_TOKEN'] });
  assert.equal(fresh.secrets[0]!.fingerprint, 'b02626ae041c', 'new environment sees updated value'); // org-token-v2
  assert.equal(fresh.secrets[0]!.declarationVersion, 2);
});

test('undeclared secret names are rejected with INPUT_ERROR and the missing names', () => {
  const { service } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'KNOWN', 'org-only-secret');
  assert.throws(
    () => service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['KNOWN', 'GHOST_A', 'GHOST_B'] }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.category, 'INPUT_ERROR');
      assert.equal(err.code, 'UNDECLARED_SECRETS');
      assert.deepEqual(err.details.missing, ['GHOST_A', 'GHOST_B']);
      return true;
    },
  );
});

test('deleting a referenced declaration fails with STATE_CONFLICT and referencers', () => {
  const { service } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  const { environment } = service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] });
  assert.throws(
    () => service.deleteDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN'),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.category, 'STATE_CONFLICT');
      assert.equal(err.code, 'DECLARATION_IN_USE');
      const refs = err.details.referencedBy as Array<{ environmentId: string }>;
      assert.equal(refs[0]!.environmentId, environment.id);
      return true;
    },
  );
});

test('deleting the environment cascades snapshots and unblocks declaration delete', () => {
  const { service, store } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  const { environment } = service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] });
  const result = service.deleteEnvironment('acme', 'web', 'prod');
  assert.equal(result.removedSnapshots, 1);
  assert.equal(store.snapshotsForEnvironment(environment.id).length, 0);
  const del = service.deleteDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN');
  assert.ok(del.deleted);
  assert.throws(
    () => service.listEnvironmentSecrets('acme', 'web', 'prod'),
    (err: unknown) => err instanceof ServiceError && err.category === 'NOT_FOUND',
  );
});

test('duplicate environment creation is a STATE_CONFLICT', () => {
  const { service } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] });
  assert.throws(
    () => service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] }),
    (err: unknown) => err instanceof ServiceError && err.category === 'STATE_CONFLICT' && err.code === 'ENVIRONMENT_EXISTS',
  );
});

test('oversized values are RESOURCE_EXHAUSTED, distinct from input errors', () => {
  const { service } = makeService();
  assert.throws(
    () => service.upsertDeclaration({ level: 'org', org: 'acme' }, 'BIG', 'x'.repeat(5000)),
    (err: unknown) => err instanceof ServiceError && err.category === 'RESOURCE_EXHAUSTED',
  );
  assert.throws(
    () => service.upsertDeclaration({ level: 'org', org: 'acme' }, '9BAD', 'v'),
    (err: unknown) => err instanceof ServiceError && err.category === 'INPUT_ERROR',
  );
});

test('bindings query by environment and by secret name', () => {
  const { service } = makeService();
  service.upsertDeclaration({ level: 'org', org: 'acme' }, 'API_TOKEN', 'org-token-v1');
  const { environment } = service.createEnvironment({ org: 'acme', project: 'web', env: 'prod', required: ['API_TOKEN'] });
  const byEnv = service.queryBindings({ environmentId: environment.id });
  assert.equal(byEnv.length, 1);
  assert.equal(byEnv[0]!.secretName, 'API_TOKEN');
  const byName = service.queryBindings({ name: 'API_TOKEN' });
  assert.equal(byName[0]!.environment.id, environment.id);
  assert.equal(byName[0]!.fingerprint, '222441c9b5e9');
});
