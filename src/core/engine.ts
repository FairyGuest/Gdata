// Execution kernel: lifecycle rules for preview environments.
// Depends only on contracts, the store adapter and an injected Clock.

import { LifecycleError, ErrorCodes } from '../contract/errors.ts';
import { hashParams, resolveEffectiveParams, resolveTtl } from '../contract/template.ts';
import { EnvStatus, OCCUPYING_STATUSES } from '../contract/types.ts';
import type {
  CreateRequest, CreateResult, Environment, EnvironmentTemplate, EnvStatus as EnvStatusT,
} from '../contract/types.ts';
import type { Clock } from './clock.ts';
import { newEnvId } from './idgen.ts';
import type { EnvironmentStore } from '../store/sqlite.ts';

export interface EngineOptions {
  template: EnvironmentTemplate;
  store: EnvironmentStore;
  clock: Clock;
  runId: string;
  maxActivePerUser: number;
  maxRenewals: number;
}

export class LifecycleEngine {
  private readonly template: EnvironmentTemplate;
  private readonly store: EnvironmentStore;
  private readonly clock: Clock;
  private readonly runId: string;
  private readonly maxActivePerUser: number;
  private readonly maxRenewals: number;

  constructor(opts: EngineOptions) {
    this.template = opts.template;
    this.store = opts.store;
    this.clock = opts.clock;
    this.runId = opts.runId;
    this.maxActivePerUser = opts.maxActivePerUser;
    this.maxRenewals = opts.maxRenewals;
  }

  private audit(envId: string | null, action: string, outcome: 'ALLOW' | 'DENY', reason: string, details: Record<string, unknown> = {}): void {
    this.store.audit({ runId: this.runId, at: this.clock.now(), envId, action, outcome, reason, details });
  }

  private transition(env: Environment, to: EnvStatusT, reason: string): void {
    const from = env.status;
    env.status = to;
    env.updatedAt = this.clock.now();
    this.store.updateEnv(env);
    this.store.recordTransition({ envId: env.id, from, to, at: env.updatedAt, reason });
  }

  create(req: CreateRequest): CreateResult {
    if (!req.owner || typeof req.owner !== 'string') {
      throw new LifecycleError(ErrorCodes.INVALID_REQUEST, 'owner is required', { field: 'owner' });
    }
    if (!req.branch || typeof req.branch !== 'string') {
      throw new LifecycleError(ErrorCodes.INVALID_REQUEST, 'branch is required', { field: 'branch' });
    }
    const params = resolveEffectiveParams(this.template, req.overrides ?? {});
    const ttlSeconds = resolveTtl(this.template, req.ttlSeconds);
    const hash = hashParams(params);

    const existing = this.store.findOccupyingByBranch(req.branch, OCCUPYING_STATUSES);
    if (existing) {
      if (existing.paramsHash === hash) {
        this.audit(existing.id, 'create', 'ALLOW', 'idempotent replay: same branch and effective params', { branch: req.branch });
        return { env: existing, idempotent: true };
      }
      this.audit(existing.id, 'create', 'DENY', 'branch occupied with different params', { branch: req.branch });
      throw new LifecycleError(
        ErrorCodes.BRANCH_PARAM_CONFLICT,
        `branch ${req.branch} already has an active environment with different parameters`,
        { branch: req.branch, existingEnvId: existing.id },
      );
    }

    const used = this.store.countOccupyingByOwner(req.owner, OCCUPYING_STATUSES);
    if (used >= this.maxActivePerUser) {
      this.audit(null, 'create', 'DENY', 'quota exhausted', { owner: req.owner, used, max: this.maxActivePerUser });
      throw new LifecycleError(
        ErrorCodes.QUOTA_EXCEEDED,
        `quota exceeded for ${req.owner}: ${used}/${this.maxActivePerUser} active environments`,
        { owner: req.owner, used, max: this.maxActivePerUser },
      );
    }

    const now = this.clock.now();
    const env: Environment = {
      id: newEnvId(),
      branch: req.branch,
      owner: req.owner,
      templateName: this.template.name,
      params,
      paramsHash: hash,
      status: EnvStatus.DEPLOYING,
      ttlSeconds,
      renewalsUsed: 0,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      updatedAt: now,
    };
    this.store.insertEnv(env);
    this.store.recordTransition({ envId: env.id, from: null, to: EnvStatus.DEPLOYING, at: now, reason: 'created from template ' + this.template.name });
    this.audit(env.id, 'create', 'ALLOW', 'environment created', { branch: req.branch, owner: req.owner, ttlSeconds });
    return { env, idempotent: false };
  }

  // Deployer callback: marks a DEPLOYING environment ready for traffic.
  markActive(id: string): Environment {
    const env = this.mustGet(id);
    if (env.status !== EnvStatus.DEPLOYING) {
      this.audit(id, 'deploy-complete', 'DENY', `cannot activate from ${env.status}`, {});
      throw new LifecycleError(ErrorCodes.INVALID_STATE, `environment ${id} is ${env.status}, expected DEPLOYING`, { envId: id, status: env.status });
    }
    this.transition(env, EnvStatus.ACTIVE, 'deployment finished');
    this.audit(id, 'deploy-complete', 'ALLOW', 'environment active', {});
    return env;
  }

  renew(id: string): Environment {
    const env = this.mustGet(id);
    if (env.status !== EnvStatus.ACTIVE && env.status !== EnvStatus.DEPLOYING) {
      this.audit(id, 'renew', 'DENY', `cannot renew in ${env.status}`, {});
      throw new LifecycleError(ErrorCodes.INVALID_STATE, `environment ${id} is ${env.status}; only live environments can be renewed`, { envId: id, status: env.status });
    }
    if (env.renewalsUsed >= this.maxRenewals) {
      this.audit(id, 'renew', 'DENY', 'renewal budget exhausted', { renewalsUsed: env.renewalsUsed, maxRenewals: this.maxRenewals });
      throw new LifecycleError(ErrorCodes.INVALID_STATE, `environment ${id} has already been renewed ${env.renewalsUsed} time(s)`, { envId: id, renewalsUsed: env.renewalsUsed, maxRenewals: this.maxRenewals });
    }
    env.renewalsUsed += 1;
    env.expiresAt += env.ttlSeconds * 1000;
    env.updatedAt = this.clock.now();
    this.store.updateEnv(env);
    this.audit(id, 'renew', 'ALLOW', `renewed (${env.renewalsUsed}/${this.maxRenewals}), expiresAt extended by ${env.ttlSeconds}s`, { expiresAt: env.expiresAt });
    return env;
  }

  remove(id: string, opts: { force?: boolean; reason?: string } = {}): Environment {
    const env = this.mustGet(id);
    if (env.status === EnvStatus.RECLAIMED || env.status === EnvStatus.DELETED) {
      this.audit(id, 'delete', 'DENY', `already ${env.status}`, {});
      throw new LifecycleError(ErrorCodes.INVALID_STATE, `environment ${id} is already ${env.status}`, { envId: id, status: env.status });
    }
    if (env.status === EnvStatus.DEPLOYING) {
      if (!opts.force) {
        this.audit(id, 'delete', 'DENY', 'delete locked while DEPLOYING', {});
        throw new LifecycleError(ErrorCodes.DELETE_LOCKED, `environment ${id} is DEPLOYING; use force with a reason`, { envId: id, status: env.status });
      }
      if (!opts.reason || opts.reason.trim() === '') {
        this.audit(id, 'delete', 'DENY', 'force delete requires a reason', {});
        throw new LifecycleError(ErrorCodes.FORCE_REASON_REQUIRED, 'force delete requires a non-empty reason', { envId: id });
      }
      this.transition(env, EnvStatus.DELETED, 'force delete: ' + opts.reason);
      this.audit(id, 'delete', 'ALLOW', 'FORCE DELETE while DEPLOYING: ' + opts.reason, { force: true, forceReason: opts.reason });
      return env;
    }
    this.transition(env, EnvStatus.DELETED, opts.reason ? 'deleted: ' + opts.reason : 'deleted by owner request');
    this.audit(id, 'delete', 'ALLOW', 'environment deleted', { force: false });
    return env;
  }

  // Reclaim every environment whose deadline has passed. Returns reclaimed ids.
  sweep(): string[] {
    const expired = this.store.listExpired(this.clock.now(), OCCUPYING_STATUSES);
    for (const env of expired) {
      this.transition(env, EnvStatus.RECLAIMED, `ttl expired at ${env.expiresAt}`);
      this.audit(env.id, 'reclaim', 'ALLOW', 'ttl expired; quota slot released', { branch: env.branch, owner: env.owner });
    }
    return expired.map((e) => e.id);
  }

  get(id: string): Environment {
    return this.mustGet(id);
  }

  query(filter: { branch?: string; status?: EnvStatusT }): Environment[] {
    return this.store.query(filter);
  }

  private mustGet(id: string): Environment {
    const env = this.store.getEnv(id);
    if (!env) {
      throw new LifecycleError(ErrorCodes.ENV_NOT_FOUND, `environment ${id} not found`, { envId: id });
    }
    return env;
  }
}

