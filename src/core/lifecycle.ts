// Execution kernel: lifecycle orchestration.
// Responsibilities: branch mutex, idempotent create, quota pool,
// TTL expiry/reclaim, one-time renew, delete lock with forced-delete audit.
// Depends only on contracts (Template, Clock, EnvironmentStore, RunLogger).

import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.ts';
import type { Template, EffectiveConfig } from '../contract/template.ts';
import { mergeOverrides } from '../contract/template.ts';
import {
  BranchConflictError, InvalidStateError, NotFoundError, QuotaExceededError, ParamValidationError,
} from '../errors.ts';
import type { EnvironmentRow, EnvironmentStore, EnvStatus } from '../store/sqliteStore.ts';
import type { RunLogger } from '../logger.ts';

export interface CreateRequest {
  branch: string;
  owner: string;
  overrides?: Record<string, unknown>;
  ttlSeconds?: number;
}

export interface CreateOutcome {
  env: EnvironmentRow;
  idempotent: boolean;
}

export interface KernelOptions {
  quotaPerOwner: number;
  deploySeconds: number;
}

function newEnvId(): string {
  return 'env-' + randomBytes(4).toString('hex');
}

function configEquals(a: EffectiveConfig, b: EffectiveConfig): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export class LifecycleKernel {
  // Per-branch promise chain serializes create/delete per branch (creation mutex).
  private branchLocks = new Map<string, Promise<unknown>>();

  private store: EnvironmentStore;
  private template: Template;
  private clock: Clock;
  private opts: KernelOptions;
  private logger: RunLogger;

  constructor(store: EnvironmentStore, template: Template, clock: Clock, opts: KernelOptions, logger: RunLogger) {
    this.store = store;
    this.template = template;
    this.clock = clock;
    this.opts = opts;
    this.logger = logger;
  }

  private withBranchLock<T>(branch: string, fn: () => T): Promise<T> {
    const prev = this.branchLocks.get(branch) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.branchLocks.set(branch, next.catch(() => undefined));
    return next;
  }

  async create(req: CreateRequest): Promise<CreateOutcome> {
    const runId = this.logger.nextRunId();
    if (typeof req.branch !== 'string' || req.branch.trim() === '') {
      throw new ParamValidationError('branch must be a non-empty string', { got: req.branch });
    }
    if (typeof req.owner !== 'string' || req.owner.trim() === '') {
      throw new ParamValidationError('owner must be a non-empty string', { got: req.owner });
    }
    const branch = req.branch;
    const { config, ttlSeconds } = mergeOverrides(this.template, req.overrides, req.ttlSeconds);
    this.logger.log(runId, 'create.request', { branch, owner: req.owner, config, ttlSeconds });

    return this.withBranchLock(branch, () => {
      const existing = this.store.findActiveByBranch(branch);
      if (existing) {
        if (configEquals(existing.config, config) && existing.ttlSeconds === ttlSeconds) {
          this.logger.log(runId, 'create.idempotent', { envId: existing.id, reason: 'same branch, same effective config' });
          return { env: existing, idempotent: true };
        }
        this.logger.log(runId, 'create.conflict', { envId: existing.id, reason: 'same branch, different effective config' });
        throw new BranchConflictError(branch, existing.id);
      }

      const activeOfOwner = this.store.listActiveByOwner(req.owner);
      if (activeOfOwner.length >= this.opts.quotaPerOwner) {
        this.logger.log(runId, 'create.quota_exceeded', {
          owner: req.owner, quota: this.opts.quotaPerOwner, activeEnvIds: activeOfOwner.map((e) => e.id),
        });
        throw new QuotaExceededError(req.owner, this.opts.quotaPerOwner, activeOfOwner.map((e) => e.id));
      }

      const now = this.clock.now();
      const env: EnvironmentRow = {
        id: newEnvId(),
        branch,
        owner: req.owner,
        config,
        ttlSeconds,
        status: 'deploying',
        createdAt: now,
        expiresAt: now + ttlSeconds * 1000,
        renewed: false,
      };
      this.store.insert(env);
      this.store.audit({ envId: env.id, action: 'create', at: now, actor: req.owner, reason: 'create request', details: { config, ttlSeconds } });
      this.logger.log(runId, 'create.ok', { envId: env.id, status: env.status, expiresAt: env.expiresAt });
      return { env, idempotent: false };
    });
  }

  renew(id: string): EnvironmentRow {
    const runId = this.logger.nextRunId();
    const env = this.mustGet(id);
    if (env.status !== 'active') {
      this.logger.log(runId, 'renew.rejected', { envId: id, status: env.status, reason: 'only active environments can be renewed' });
      throw new InvalidStateError('ENV_NOT_ACTIVE', `environment '${id}' is ${env.status}; only active environments can be renewed`, { envId: id, status: env.status });
    }
    if (env.renewed) {
      this.logger.log(runId, 'renew.rejected', { envId: id, reason: 'renewal already used' });
      throw new InvalidStateError('ALREADY_RENEWED', `environment '${id}' has already been renewed once`, { envId: id });
    }
    const now = this.clock.now();
    const newExpiresAt = env.expiresAt + env.ttlSeconds * 1000;
    this.store.extendExpiry(id, newExpiresAt, now);
    this.store.audit({ envId: id, action: 'renew', at: now, actor: env.owner, reason: 'one-time renewal', details: { previousExpiresAt: env.expiresAt, newExpiresAt } });
    this.logger.log(runId, 'renew.ok', { envId: id, newExpiresAt });
    return this.mustGet(id);
  }

  async delete(id: string, opts: { force?: boolean; reason?: string; actor?: string } = {}): Promise<EnvironmentRow> {
    const runId = this.logger.nextRunId();
    const env = this.mustGet(id);
    return this.withBranchLock(env.branch, () => {
      const current = this.mustGet(id);
      if (current.status === 'deleted' || current.status === 'reclaimed') {
        this.logger.log(runId, 'delete.rejected', { envId: id, status: current.status, reason: 'environment already terminated' });
        throw new InvalidStateError('ENV_ALREADY_TERMINATED', `environment '${id}' is already ${current.status}`, { envId: id, status: current.status });
      }
      const now = this.clock.now();
      if (current.status === 'deploying' && opts.force !== true) {
        this.logger.log(runId, 'delete.rejected', { envId: id, status: 'deploying', reason: 'deployment in progress; use force with a reason' });
        throw new InvalidStateError('DEPLOY_IN_PROGRESS',
          `environment '${id}' is still deploying; pass force=true with a reason to delete`, { envId: id, status: 'deploying' });
      }
      if (current.status === 'deploying' && opts.force === true) {
        if (typeof opts.reason !== 'string' || opts.reason.trim() === '') {
          throw new ParamValidationError('force delete during deployment requires a non-empty reason', { envId: id });
        }
        this.store.audit({
          envId: id, action: 'force_delete', at: now, actor: opts.actor ?? current.owner,
          reason: opts.reason, details: { statusAtDelete: current.status, forced: true },
        });
        this.logger.log(runId, 'delete.forced', { envId: id, reason: opts.reason });
      } else {
        this.store.audit({
          envId: id, action: 'delete', at: now, actor: opts.actor ?? current.owner,
          reason: opts.reason ?? 'user requested delete', details: { statusAtDelete: current.status, forced: false },
        });
      }
      this.store.updateStatus(id, 'deleted', now, opts.force === true ? 'force deleted' : 'deleted');
      this.logger.log(runId, 'delete.ok', { envId: id });
      return this.mustGet(id);
    });
  }

  // Sweeper: finalize finished deployments and reclaim expired environments.
  tick(): { deployed: string[]; reclaimed: string[] } {
    const runId = this.logger.nextRunId();
    const now = this.clock.now();
    const deployed: string[] = [];
    const reclaimed: string[] = [];
    for (const env of this.store.listDeployingReady(now, this.opts.deploySeconds)) {
      this.store.updateStatus(env.id, 'active', now, 'deployment finished');
      deployed.push(env.id);
    }
    for (const env of this.store.listExpired(now)) {
      this.store.updateStatus(env.id, 'reclaimed', now, 'ttl expired');
      this.store.audit({ envId: env.id, action: 'reclaim', at: now, actor: 'system', reason: 'ttl expired; quota released', details: { expiresAt: env.expiresAt } });
      reclaimed.push(env.id);
    }
    this.logger.log(runId, 'tick', { now, deployed, reclaimed });
    return { deployed, reclaimed };
  }

  get(id: string): EnvironmentRow {
    return this.mustGet(id);
  }

  list(filter: { branch?: string; status?: EnvStatus }): EnvironmentRow[] {
    return this.store.list(filter);
  }

  private mustGet(id: string): EnvironmentRow {
    const env = this.store.get(id);
    if (!env) throw new NotFoundError(id);
    return env;
  }
}
