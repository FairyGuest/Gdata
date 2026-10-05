import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestRecorder } from '../src/state/recorder.ts';
import { MockError } from '../src/contracts/errors.ts';

function entry(path: string) {
  return {
    method: 'GET', path, query: { a: '1' }, headers: { 'x-t': 'v' }, body: '',
    routeId: 'r', matched: true, receivedAt: new Date().toISOString(),
  };
}

test('记录保持插入顺序且可过滤', () => {
  const rec = new RequestRecorder();
  rec.record(entry('/a'));
  rec.record(entry('/b'));
  rec.record({ ...entry('/a'), method: 'POST' });
  const all = rec.list();
  assert.deepEqual(all.map((r) => [r.method, r.path]), [['GET', '/a'], ['GET', '/b'], ['POST', '/a']]);
  assert.equal(rec.count({ path: '/a' }), 2);
  assert.equal(rec.count({ method: 'POST' }), 1);
  assert.equal(all[0].query.a, '1');
  assert.equal(all[0].headers['x-t'], 'v');
  rec.close();
});

test('容量超限抛 RESOURCE_EXHAUSTED', () => {
  const rec = new RequestRecorder({ maxRecords: 2 });
  rec.record(entry('/a'));
  rec.record(entry('/b'));
  assert.throws(() => rec.record(entry('/c')), (err) => {
    assert.ok(err instanceof MockError);
    assert.equal(err.category, 'RESOURCE_EXHAUSTED');
    assert.equal(err.code, 'RECORDER_CAPACITY_EXCEEDED');
    return true;
  });
  rec.close();
});

test('reset 清空记录且序号重新从 1 开始', () => {
  const rec = new RequestRecorder();
  rec.record(entry('/a'));
  rec.reset();
  assert.equal(rec.count(), 0);
  const seq = rec.record(entry('/b'));
  assert.equal(seq, 1);
  rec.close();
});
