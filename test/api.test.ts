// HTTP contract tests via fastify inject (no network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../src/state/store.js';
import { SecretService } from '../src/core/service.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';

function makeApp() {
  const store = new SecretStore(':memory:');
  const config = loadConfig({ ...process.env, ESB_LOG_FILE: '' });
  const logger = createLogger(null, 'api-test-run');
  const service = new SecretService(store, config, logger);
  return buildServer(service, logger);
}

test('full flow: declare, create env, redacted query, conflict delete, cascade', async () => {
  const app = makeApp();

  const put = async (url: string, value: string) =>
    app.inject({ method: 'PUT', url, payload: { value } });

  let r = await put('/orgs/acme/secrets/API_TOKEN', 'org-token-v1');
  assert.equal(r.statusCode, 201 - 1); // 200
  assert.equal(r.json().version, 1);
  await put('/orgs/acme/projects/web/secrets/API_TOKEN', 'proj-token-v1');
  await put('/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN', 'env-token-v1');
  await put('/orgs/acme/secrets/ORG_ONLY', 'org-only-secret');

  r = await app.inject({
    method: 'POST',
    url: '/orgs/acme/projects/web/environments',
    payload: { env: 'prod', required: ['API_TOKEN', 'ORG_ONLY'] },
  });
  assert.equal(r.statusCode, 201);
  const created = r.json();
  const envId = created.environment.id;

  r = await app.inject({ method: 'GET', url: '/orgs/acme/projects/web/environments/prod/secrets' });
  assert.equal(r.statusCode, 200);
  const body = r.body;
  // Redaction contract: plaintext values must never appear in the response.
  assert.ok(!body.includes('env-token-v1'), 'response must not contain env plaintext');
  assert.ok(!body.includes('org-token-v1'), 'response must not contain org plaintext');
  assert.ok(!body.includes('org-only-secret'), 'response must not contain org-only plaintext');
  const secrets = r.json().secrets;
  const token = secrets.find((s: any) => s.name === 'API_TOKEN');
  assert.equal(token.level, 'env');
  assert.equal(token.fingerprint, 'b8f5e926903f');

  // Referenced declaration cannot be deleted: 409 with referencers.
  r = await app.inject({ method: 'DELETE', url: '/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN' });
  assert.equal(r.statusCode, 409);
  const conflict = r.json();
  assert.equal(conflict.error.category, 'STATE_CONFLICT');
  assert.equal(conflict.error.details.referencedBy[0].environmentId, envId);

  // Cascade delete of the environment, then declaration delete succeeds.
  r = await app.inject({ method: 'DELETE', url: '/orgs/acme/projects/web/environments/prod' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().removedSnapshots, 2);
  r = await app.inject({ method: 'DELETE', url: '/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN' });
  assert.equal(r.statusCode, 200);

  await app.close();
});

test('error contract: missing secrets -> 400 INPUT_ERROR with missing names', async () => {
  const app = makeApp();
  const r = await app.inject({
    method: 'POST',
    url: '/orgs/acme/projects/web/environments',
    payload: { env: 'prod', required: ['NOPE_ONE', 'NOPE_TWO'] },
  });
  assert.equal(r.statusCode, 400);
  const body = r.json();
  assert.equal(body.error.category, 'INPUT_ERROR');
  assert.equal(body.error.code, 'UNDECLARED_SECRETS');
  assert.deepEqual(body.error.details.missing, ['NOPE_ONE', 'NOPE_TWO']);
  await app.close();
});

test('error contract: unknown environment -> 404 NOT_FOUND', async () => {
  const app = makeApp();
  const r = await app.inject({ method: 'GET', url: '/orgs/acme/projects/web/environments/ghost/secrets' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error.category, 'NOT_FOUND');
  await app.close();
});

test('error contract: invalid secret name -> 400 INPUT_ERROR', async () => {
  const app = makeApp();
  const r = await app.inject({ method: 'PUT', url: '/orgs/acme/secrets/9BAD', payload: { value: 'x' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error.code, 'INVALID_SECRET_NAME');
  await app.close();
});

test('snapshot isolation over HTTP: declaration update leaves old env untouched', async () => {
  const app = makeApp();
  await app.inject({ method: 'PUT', url: '/orgs/acme/secrets/API_TOKEN', payload: { value: 'org-token-v1' } });
  await app.inject({
    method: 'POST',
    url: '/orgs/acme/projects/web/environments',
    payload: { env: 'prod', required: ['API_TOKEN'] },
  });
  await app.inject({ method: 'PUT', url: '/orgs/acme/secrets/API_TOKEN', payload: { value: 'org-token-v2' } });
  const r = await app.inject({ method: 'GET', url: '/orgs/acme/projects/web/environments/prod/secrets' });
  const token = r.json().secrets[0];
  assert.equal(token.fingerprint, '222441c9b5e9');
  assert.equal(token.declarationVersion, 1);
  await app.close();
});
