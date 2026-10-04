/** 演示脚本：内存库 + 虚拟时钟，跑通 建层级 -> 发钥 -> 扣减 -> 超限 -> 轮换 -> 过期 全链路。 */
import { VirtualClock } from '../src/domain/clock.ts';
import { RingLogger } from '../src/domain/logger.ts';
import { SqliteStore } from '../src/store/sqliteStore.ts';
import { QuotaService } from '../src/service/quotaService.ts';

const store = new SqliteStore(':memory:');
const clock = new VirtualClock();
const logger = new RingLogger(200, 'demo-run');
const service = new QuotaService({ store, clock, logger, gracePeriodMs: 5000 });

service.createScope({ id: 'global', level: 'global', quotaLimit: 100 });
service.createScope({ id: 'org-a', level: 'org', parentId: 'global', quotaLimit: 60 });
service.createScope({ id: 'proj-1', level: 'project', parentId: 'org-a', quotaLimit: 10 });

const key = service.createKey({ projectScopeId: 'proj-1' });
console.log('issued key:', key.id, key.secret.slice(0, 12) + '...');

console.log('consume 4 ->', JSON.stringify(service.consume(key.secret, 4, 'demo-req-1').balances));

try {
  service.consume(key.secret, 7);
} catch (err) {
  console.log('consume 7 rejected:', (err as Error).message);
}

const { oldKey, newKey } = service.rotate(key.secret);
console.log('rotated: old', oldKey.id, 'grace until', oldKey.graceUntil, '-> new', newKey.id);
service.consume(key.secret, 1); // 宽限期内旧钥仍可用
clock.advance(6000);
console.log('swept expired:', service.sweepExpired());

const report = service.usageReport(newKey.secret);
console.log('usage report for new key:', JSON.stringify(report, null, 2));

console.log('\n--- replay log ---');
for (const e of logger.recent(50)) {
  console.log('#' + e.seq, e.event, e.reason, JSON.stringify(e.state));
}
store.close();
