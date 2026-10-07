// Execution kernel: orchestrates validation, resolution and persistence.
// All failures are raised as ServiceError with an explicit category; nothing
// is silently swallowed or coerced to success.
import { createHash, randomUUID } from 'node:crypto';
import {
  Declaration,
  EnvironmentRow,
  RedactedSecret,
  ResolvedSecret,
  ScopeRef,
  ServiceError,
  SnapshotEntry,
} from '../contracts/types.js';
import { resolveSecrets, scopePathOf } from './resolver.js';
import { SecretStore } from '../state/store.js';
import { Logger } from '../logging.js';
import { AppConfig } from '../config.js';

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CreateEnvironmentInput {
  org: string;
  project: string;
  env: string;
  required: string[];
}

export interface CreateEnvironmentResult {
  environment: EnvironmentRow;
  secrets: RedactedSecret[];
}

export class SecretService {
  constructor(
    private readonly store: SecretStore,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private fingerprint(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, this.config.fingerprintLength);
  }

  private validateSegment(kind: string, value: unknown): string {
    if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value)) {
      throw new ServiceError('INPUT_ERROR', 'INVALID_SEGMENT', `invalid ${kind}: must match ${SEGMENT_PATTERN}`, { [kind]: value });
    }
    return value;
  }

  private validateSecretName(name: unknown): string {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new ServiceError('INPUT_ERROR', 'INVALID_SECRET_NAME', 'secret name must match ' + NAME_PATTERN, { name });
    }
    return name;
  }

  private validateValue(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ServiceError('INPUT_ERROR', 'INVALID_VALUE', 'secret value must be a non-empty string');
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.config.maxValueBytes) {
      throw new ServiceError('RESOURCE_EXHAUSTED', 'VALUE_TOO_LARGE', `secret value exceeds ${this.config.maxValueBytes} bytes`, { bytes });
    }
    return value;
  }

  private normalizeScope(scope: ScopeRef): { level: ScopeRef['level']; org: string; project: string | null; env: string | null } {
    const org = this.validateSegment('org', scope.org);
    if (scope.level === 'org') return { level: 'org', org, project: null, env: null };
    const project = this.validateSegment('project', scope.project);
    if (scope.level === 'project') return { level: 'project', org, project, env: null };
    const env = this.validateSegment('env', scope.env);
    return { level: 'env', org, project, env };
  }

  upsertDeclaration(scope: ScopeRef, nameRaw: unknown, valueRaw: unknown): Declaration {
    const s = this.normalizeScope(scope);
    const name = this.validateSecretName(nameRaw);
    const value = this.validateValue(valueRaw);
    const existing = this.store.getDeclaration(s.level, s.org, s.project, s.env, name);
    const declaration: Declaration = {
      id: existing?.id ?? randomUUID(),
      scopeLevel: s.level,
      org: s.org,
      project: s.project,
      env: s.env,
      name,
      value,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsertDeclaration(declaration);
    this.logger.info('declaration.upserted', {
      scopePath: scopePathOf(declaration),
      name,
      version: declaration.version,
      reason: existing ? 'update existing declaration' : 'create new declaration',
    });
    return this.store.getDeclaration(s.level, s.org, s.project, s.env, name)!;
  }

  deleteDeclaration(scope: ScopeRef, nameRaw: unknown): { deleted: string } {
    const s = this.normalizeScope(scope);
    const name = this.validateSecretName(nameRaw);
    const existing = this.store.getDeclaration(s.level, s.org, s.project, s.env, name);
    if (!existing) {
      throw new ServiceError('NOT_FOUND', 'DECLARATION_NOT_FOUND', `no declaration for ${name} at ${scopePathOf({ scopeLevel: s.level, org: s.org, project: s.project, env: s.env })}`);
    }
    const referencers = this.store.activeReferencingEnvironments(existing.id);
    if (referencers.length > 0) {
      this.logger.warn('declaration.delete.rejected', {
        declarationId: existing.id,
        name,
        reason: 'still referenced by active environment snapshots',
        referencers: referencers.map((e) => e.id),
      });
      throw new ServiceError('STATE_CONFLICT', 'DECLARATION_IN_USE', `declaration ${name} is still referenced by active environment snapshots`, {
        declarationId: existing.id,
        referencedBy: referencers.map((e) => ({
          environmentId: e.id,
          org: e.org,
          project: e.project,
          env: e.env,
        })),
      });
    }
    this.store.deleteDeclaration(existing.id);
    this.logger.info('declaration.deleted', { declarationId: existing.id, name, reason: 'no active references' });
    return { deleted: existing.id };
  }

  createEnvironment(input: CreateEnvironmentInput): CreateEnvironmentResult {
    const org = this.validateSegment('org', input.org);
    const project = this.validateSegment('project', input.project);
    const env = this.validateSegment('env', input.env);
    if (!Array.isArray(input.required)) {
      throw new ServiceError('INPUT_ERROR', 'INVALID_REQUIRED', 'required must be an array of secret names');
    }
    const required = input.required.map((n) => this.validateSecretName(n));
    if (required.length > this.config.maxSecretsPerEnvironment) {
      throw new ServiceError('RESOURCE_EXHAUSTED', 'TOO_MANY_SECRETS', `required exceeds limit of ${this.config.maxSecretsPerEnvironment}`, { count: required.length });
    }
    const existing = this.store.getEnvironment(org, project, env);
    if (existing && existing.status === 'active') {
      throw new ServiceError('STATE_CONFLICT', 'ENVIRONMENT_EXISTS', `environment ${org}/${project}/${env} already exists`, { environmentId: existing.id });
    }

    const visible = this.store.declarationsForChain(org, project, env);
    const result = resolveSecrets(visible, required);
    this.logger.info('environment.resolution', {
      org, project, env,
      required,
      visibleDeclarations: visible.map((d) => ({ name: d.name, level: d.scopeLevel, version: d.version })),
      decisions: result.decisions.map((d) => ({
        name: d.name,
        winnerLevel: d.winner.scopeLevel,
        winnerVersion: d.winner.version,
        overridden: d.overridden,
        reason: 'nearest scope wins per key',
      })),
      missing: result.missing,
    });
    if (result.missing.length > 0) {
      throw new ServiceError('INPUT_ERROR', 'UNDECLARED_SECRETS', `secret names not declared at any scope: ${result.missing.join(', ')}`, { missing: result.missing });
    }

    const now = new Date().toISOString();
    const environment: EnvironmentRow = {
      id: randomUUID(),
      org, project, env,
      status: 'active',
      createdAt: now,
      deletedAt: null,
    };
    const snapshots: SnapshotEntry[] = result.resolved.map((r: ResolvedSecret) => ({
      id: randomUUID(),
      environmentId: environment.id,
      name: r.name,
      value: r.value,
      fingerprint: this.fingerprint(r.value),
      sourceLevel: r.sourceLevel,
      sourcePath: r.sourcePath,
      declarationId: r.declarationId,
      declarationVersion: r.declarationVersion,
      createdAt: now,
    }));

    this.store.transaction(() => {
      if (existing) {
        // A previously deleted environment is being recreated: clear its old snapshots.
        this.store.deleteSnapshotsForEnvironment(existing.id);
        this.store.markEnvironmentDeleted(existing.id, now);
      }
      this.store.insertEnvironment(environment);
      for (const s of snapshots) this.store.insertSnapshot(s);
    });
    this.logger.info('environment.created', {
      environmentId: environment.id,
      org, project, env,
      snapshotCount: snapshots.length,
      snapshotIds: snapshots.map((s) => s.id),
      reason: 'injection snapshot finalized at creation time',
    });

    return { environment, secrets: snapshots.map((s) => this.redact(s)) };
  }

  private redact(s: SnapshotEntry): RedactedSecret {
    return {
      name: s.name,
      level: s.sourceLevel,
      sourcePath: s.sourcePath,
      fingerprint: s.fingerprint,
      declarationVersion: s.declarationVersion,
      snapshotId: s.id,
      capturedAt: s.createdAt,
    };
  }

  private requireActiveEnvironment(org: string, project: string, env: string): EnvironmentRow {
    const e = this.store.getEnvironment(org, project, env);
    if (!e || e.status !== 'active') {
      throw new ServiceError('NOT_FOUND', 'ENVIRONMENT_NOT_FOUND', `environment ${org}/${project}/${env} not found`);
    }
    return e;
  }

  listEnvironmentSecrets(orgRaw: unknown, projectRaw: unknown, envRaw: unknown): { environment: EnvironmentRow; secrets: RedactedSecret[] } {
    const org = this.validateSegment('org', orgRaw);
    const project = this.validateSegment('project', projectRaw);
    const env = this.validateSegment('env', envRaw);
    const environment = this.requireActiveEnvironment(org, project, env);
    const snapshots = this.store.snapshotsForEnvironment(environment.id);
    return { environment, secrets: snapshots.map((s) => this.redact(s)) };
  }

  deleteEnvironment(orgRaw: unknown, projectRaw: unknown, envRaw: unknown): { environmentId: string; removedSnapshots: number } {
    const org = this.validateSegment('org', orgRaw);
    const project = this.validateSegment('project', projectRaw);
    const env = this.validateSegment('env', envRaw);
    const environment = this.requireActiveEnvironment(org, project, env);
    const removed = this.store.transaction(() => {
      const n = this.store.deleteSnapshotsForEnvironment(environment.id);
      this.store.markEnvironmentDeleted(environment.id, new Date().toISOString());
      return n;
    });
    this.logger.info('environment.deleted', {
      environmentId: environment.id,
      removedSnapshots: removed,
      reason: 'cascade cleanup of injection snapshots',
    });
    return { environmentId: environment.id, removedSnapshots: removed };
  }

  queryBindings(filter: { environmentId?: string; name?: string }) {
    if (filter.name !== undefined) this.validateSecretName(filter.name);
    const rows = this.store.queryBindings(filter);
    return rows.map((r) => ({
      secretName: r.name,
      fingerprint: r.fingerprint,
      sourceLevel: r.sourceLevel,
      sourcePath: r.sourcePath,
      declarationId: r.declarationId,
      declarationVersion: r.declarationVersion,
      snapshotId: r.id,
      environment: {
        id: r.environment.id,
        org: r.environment.org,
        project: r.environment.project,
        env: r.environment.env,
        status: r.environment.status,
      },
      capturedAt: r.createdAt,
    }));
  }
}


