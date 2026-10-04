/** 领域服务层：组合 Store/Clock/Logger，实现配额扣减、密钥轮换与用量报告。 */
import { randomUUID, randomBytes } from 'node:crypto';
import { AppError } from '../domain/errors.ts';
import type { Clock } from '../domain/clock.ts';
import type { RingLogger } from '../domain/logger.ts';
import type { ApiKey, ConsumeResult, RotateResult, Scope, ScopeLevel, UsageReport } from '../domain/types.ts';
import type { SqliteStore } from '../store/sqliteStore.ts';

export interface QuotaServiceDeps {
  store: SqliteStore;
  clock: Clock;
  logger: RingLogger;
  gracePeriodMs: number;
}

export class QuotaService {
  private readonly deps: QuotaServiceDeps;

  constructor(deps: QuotaServiceDeps) {
    this.deps = deps;
  }

  createScope(input: { id: string; level: ScopeLevel; parentId?: string | null; quotaLimit: number }): Scope {
    const { id, level, quotaLimit } = input;
    const parentId = input.parentId ?? null;
    if (!id || typeof id !== 'string') throw new AppError('INVALID_REQUEST', 'scope id is required');
    if (!Number.isInteger(quotaLimit) || quotaLimit < 0) {
      throw new AppError('INVALID_REQUEST', 'quotaLimit must be a non-negative integer', { quotaLimit });
    }
    if (level === 'global' && parentId !== null) {
      throw new AppError('INVALID_REQUEST', 'global scope must not have a parent', { scopeId: id });
    }
    if (level !== 'global') {
      if (!parentId) throw new AppError('INVALID_REQUEST', level + ' scope requires a parent', { scopeId: id });
      const parent = this.deps.store.getScope(parentId);
      if (!parent) throw new AppError('NOT_FOUND', 'parent scope not found: ' + parentId, { scopeId: parentId });
      const expectedParent: ScopeLevel = level === 'org' ? 'global' : 'org';
      if (parent.level !== expectedParent) {
        throw new AppError('INVALID_REQUEST', level + ' scope parent must be ' + expectedParent, {
          scopeId: id,
          parentId,
          parentLevel: parent.level,
        });
      }
    }
    const scope = this.deps.store.createScope({ id, level, parentId, quotaLimit });
    this.deps.logger.log('scope.created', { scopeId: id, level, parentId, quotaLimit }, 'scope registered');
    return scope;
  }

  createKey(input: { projectScopeId: string; id?: string }): ApiKey {
    const { projectScopeId } = input;
    const scope = this.deps.store.getScope(projectScopeId);
    if (!scope) throw new AppError('NOT_FOUND', 'project scope not found: ' + projectScopeId, { scopeId: projectScopeId });
    if (scope.level !== 'project') {
      throw new AppError('INVALID_REQUEST', 'keys must bind to a project scope', { scopeId: projectScopeId, level: scope.level });
    }
    const key: ApiKey = {
      id: input.id ?? 'key_' + randomUUID(),
      secret: 'sk_' + randomBytes(24).toString('hex'),
      projectScopeId,
      status: 'active',
      createdAt: this.deps.clock.now(),
      graceUntil: null,
      rotatedTo: null,
    };
    this.deps.store.insertKey(key);
    this.deps.logger.log('key.created', { keyId: key.id, projectScopeId }, 'api key issued');
    return key;
  }

  /** 消费配额：校验密钥状态后走单事务三层原子扣减。 */
  consume(secret: string, amount: number, requestId: string | null = null): ConsumeResult {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError('INVALID_REQUEST', 'amount must be a positive integer', { amount });
    }
    const key = this.requireUsableKey(secret, requestId);
    const chain = this.deps.store.scopeChain(key.projectScopeId);
    const at = this.deps.clock.now();
    try {
      const { balances } = this.deps.store.consumeAtomic(chain, key.id, amount, at, requestId);
      this.deps.logger.log(
        'quota.consumed',
        { keyId: key.id, amount, balances: balances.map((b) => [b.level, b.used, b.limit]) },
        'all three levels within limit; committed',
        requestId,
      );
      return { keyId: key.id, amount, at, requestId, balances };
    } catch (err) {
      if (err instanceof AppError && err.code === 'QUOTA_EXCEEDED') {
        this.deps.logger.log('quota.rejected', { keyId: key.id, amount, ...err.details }, err.message, requestId);
      }
      throw err;
    }
  }

  /** 轮换：旧钥进入宽限期（grace），宽限到期后由 sweep 置为 expired。 */
  rotate(secret: string): RotateResult {
    const oldKey = this.deps.store.findKeyBySecret(secret);
    if (!oldKey) throw new AppError('KEY_UNKNOWN', 'unknown api key');
    if (oldKey.status === 'expired') throw new AppError('KEY_EXPIRED', 'cannot rotate an expired key', { keyId: oldKey.id });
    if (oldKey.status === 'grace') throw new AppError('CONFLICT', 'key already rotated', { keyId: oldKey.id, rotatedTo: oldKey.rotatedTo });
    const newKey = this.createKey({ projectScopeId: oldKey.projectScopeId });
    const graceUntil = this.deps.clock.now() + this.deps.gracePeriodMs;
    this.deps.store.markKeyGrace(oldKey.id, graceUntil, newKey.id);
    this.deps.logger.log(
      'key.rotated',
      { oldKeyId: oldKey.id, newKeyId: newKey.id, graceUntil },
      'old key usable until grace deadline (' + this.deps.gracePeriodMs + 'ms)',
    );
    return { oldKey: { ...oldKey, status: 'grace', graceUntil, rotatedTo: newKey.id }, newKey };
  }

  /** 宽限期到期扫描：把 grace 且超过 graceUntil 的密钥置为 expired。 */
  sweepExpired(): string[] {
    const now = this.deps.clock.now();
    const expired: string[] = [];
    for (const key of this.deps.store.listKeys().filter((k) => k.status === 'grace')) {
      if (key.graceUntil !== null && key.graceUntil <= now) {
        this.deps.store.markKeyExpired(key.id);
        expired.push(key.id);
        this.deps.logger.log('key.expired', { keyId: key.id, graceUntil: key.graceUntil }, 'grace period elapsed');
      }
    }
    return expired;
  }

  usageReport(secret: string): UsageReport {
    const key = this.deps.store.findKeyBySecret(secret);
    if (!key) throw new AppError('KEY_UNKNOWN', 'unknown api key');
    const chain = this.deps.store.scopeChain(key.projectScopeId);
    return {
      keyId: key.id,
      status: key.status,
      totalConsumed: this.deps.store.totalConsumedForKey(key.id),
      events: this.deps.store.usageEventsForKey(key.id),
      balances: chain.map((s) => ({
        level: s.level,
        scopeId: s.id,
        limit: s.quotaLimit,
        used: s.quotaUsed,
        remaining: s.quotaLimit - s.quotaUsed,
      })),
    };
  }

  private requireUsableKey(secret: string, requestId: string | null): ApiKey {
    const key = this.deps.store.findKeyBySecret(secret);
    if (!key) {
      this.deps.logger.log('key.rejected', {}, 'unknown secret', requestId);
      throw new AppError('KEY_UNKNOWN', 'unknown api key');
    }
    if (key.status === 'expired') {
      this.deps.logger.log('key.rejected', { keyId: key.id, status: key.status }, 'key expired', requestId);
      throw new AppError('KEY_EXPIRED', 'api key expired', { keyId: key.id });
    }
    if (key.status === 'grace' && key.graceUntil !== null && key.graceUntil <= this.deps.clock.now()) {
      this.deps.store.markKeyExpired(key.id);
      this.deps.logger.log('key.expired', { keyId: key.id, graceUntil: key.graceUntil }, 'grace period elapsed at consume time', requestId);
      throw new AppError('KEY_EXPIRED', 'api key grace period elapsed', { keyId: key.id });
    }
    return key;
  }
}
