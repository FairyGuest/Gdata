import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp, BuiltApp } from '../src/app.js';
import { AppConfig, loadConfig } from '../src/config.js';

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<BuiltApp> {
  const config: AppConfig = {
    ...loadConfig(),
    dbPath: ':memory:',
    lockWaitMs: 500,
    diagConsole: false,
    diagLogPath: null,
    ...overrides,
  };
  return buildApp(config);
}

async function call(app: BuiltApp, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.app.inject({ method, url, payload: payload as never });
  return { status: response.statusCode, body: response.json() };
}

describe('resource and computation failures', () => {
  it('classifies unavailable storage as 503', async () => {
    const app = await makeApp();
    try {
      const disabled = await call(app, 'POST', '/admin/faults/storage-unavailable', {
        unavailable: true,
      });
      assert.equal(disabled.status, 200);
      const failed = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-conservation',
        sellerId: 'u-alice',
        price: 1,
      });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error.category, 'resource');
      assert.equal(failed.body.error.reason, 'resource.storage_unavailable');

      await call(app, 'POST', '/admin/faults/storage-unavailable', { unavailable: false });
      const health = await call(app, 'GET', '/health');
      assert.equal(health.body.storage, 'available');
    } finally {
      await app.close();
    }
  });

  it('classifies a real SQLite write-lock wait as resource.lock_timeout', async () => {
    const dbDir = join(process.cwd(), '.tmp-test-locks');
    const dbPath = join(dbDir, 'lock.db');
    rmSync(dbPath, { force: true });
    const app = await makeApp({ dbPath, lockWaitMs: 30 });
    const release = app.ledger.holdExternalWriteLock();
    try {
      const failed = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-conservation',
        sellerId: 'u-alice',
        price: 1,
      });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error.category, 'resource');
      assert.equal(failed.body.error.reason, 'resource.lock_timeout');
    } finally {
      release();
      await app.close();
    }
  });

  it('classifies a conservation failure as 500 and records the reason', async () => {
    const app = await makeApp();
    try {
      const failed = await call(app, 'POST', '/admin/faults/conservation-failure', {});
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error.category, 'computation');
      assert.equal(failed.body.error.reason, 'computation.conservation_violation');
      const runs = await call(app, 'GET', '/diag/runs');
      const rejected = runs.body.runs.find(
        (event: any) => event.reason === 'computation.conservation_violation',
      );
      assert.ok(rejected);
      assert.equal(rejected.decision, 'rejected');
      assert.equal(rejected.httpStatus, 500);
      assert.equal(rejected.category, 'computation');
    } finally {
      await app.close();
    }
  });
});
