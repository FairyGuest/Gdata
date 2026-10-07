import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.ts";
import { resolveSecrets, type ScopeChainEntry } from "../domain/resolver.ts";
import type {
  BindingRow,
  Environment,
  MaskedSecret,
  ResolvedSecret,
  ScopeType,
  SecretDeclaration,
} from "../domain/types.ts";
import { Store } from "../state/store.ts";
import { ConsoleRunLogger, type RunLogger } from "./logger.ts";

const SCOPE_TYPES: ScopeType[] = ["org", "project", "env"];

export interface DeclareSecretInput {
  scopeType: ScopeType;
  scopeId: string;
  name: string;
  value: string;
}

export interface CreateEnvironmentInput {
  id?: string;
  orgId: string;
  projectId: string;
  name: string;
  requiredSecrets: string[];
}

export interface CreateEnvironmentResult {
  environment: Environment;
  resolved: ResolvedSecret[];
}

export class BindingService {
  private readonly store: Store;
  private readonly fingerprintLength: number;
  private readonly logger: RunLogger;

  constructor(store: Store, fingerprintLength: number, logger: RunLogger = new ConsoleRunLogger()) {
    this.store = store;
    this.fingerprintLength = fingerprintLength;
    this.logger = logger;
  }

  declareSecret(input: DeclareSecretInput, runId: string = randomUUID()): SecretDeclaration {
    if (!SCOPE_TYPES.includes(input.scopeType)) {
      throw new AppError("VALIDATION_ERROR", `Invalid scopeType: ${input.scopeType}`, {
        allowed: SCOPE_TYPES,
      });
    }
    requireNonEmpty(input.scopeId, "scopeId");
    requireNonEmpty(input.name, "name");
    requireNonEmpty(input.value, "value");
    const existing = this.store.getDeclaration(input.scopeType, input.scopeId, input.name);
    const decl: SecretDeclaration = {
      id: existing?.id ?? randomUUID(),
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      name: input.name,
      value: input.value,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.store.upsertDeclaration(decl);
    this.logger.log({
      runId,
      step: "declareSecret",
      state: { scopeType: decl.scopeType, scopeId: decl.scopeId, name: decl.name, version: decl.version },
      reason: existing ? "existing declaration updated, version bumped" : "new declaration created",
      outcome: "ok",
    });
    return this.store.getDeclaration(input.scopeType, input.scopeId, input.name)!;
  }

  createEnvironment(input: CreateEnvironmentInput, runId: string = randomUUID()): CreateEnvironmentResult {
    requireNonEmpty(input.orgId, "orgId");
    requireNonEmpty(input.projectId, "projectId");
    requireNonEmpty(input.name, "name");
    if (!Array.isArray(input.requiredSecrets) || input.requiredSecrets.length === 0) {
      throw new AppError("VALIDATION_ERROR", "requiredSecrets must be a non-empty array of names");
    }
    if (input.id !== undefined) {
      requireNonEmpty(input.id, "id");
      if (this.store.getEnvironment(input.id)) {
        throw new AppError("CONFLICT_DUPLICATE", "Environment id already exists: " + input.id);
      }
    }
    const envId = input.id ?? randomUUID();
    const chain: ScopeChainEntry[] = [
      { scopeType: "org", scopeId: input.orgId },
      { scopeType: "project", scopeId: input.projectId },
      { scopeType: "env", scopeId: envId },
    ];
    const declarations = this.store.declarationsForChain(input.orgId, input.projectId, envId);
    this.logger.log({
      runId,
      step: "createEnvironment.collect",
      state: { chain, declaredNames: declarations.map((d) => `${d.scopeType}/${d.name}`) },
      reason: "collected declarations along org->project->env chain",
      outcome: "ok",
    });
    const resolved = resolveSecrets(input.requiredSecrets, chain, declarations, this.fingerprintLength);
    const env: Environment = {
      id: envId,
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.name,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.store.createEnvironment(env);
    for (const item of resolved) {
      this.store.insertSnapshot({
        id: randomUUID(),
        envId,
        name: item.name,
        level: item.level,
        sourcePath: item.sourcePath,
        declarationId: item.declarationId,
        declarationVersion: item.declarationVersion,
        value: item.value,
        fingerprint: item.fingerprint,
        createdAt: env.createdAt,
      });
    }
    this.logger.log({
      runId,
      step: "createEnvironment.snapshot",
      state: {
        envId,
        snapshot: resolved.map((r) => ({
          name: r.name,
          level: r.level,
          version: r.declarationVersion,
          fingerprint: r.fingerprint,
        })),
      },
      reason: "resolution frozen into injection snapshot at environment creation time",
      outcome: "ok",
    });
    return { environment: env, resolved };
  }

  /** Masked view: name, effective level and fingerprint only; never returns plaintext. */
  getEnvironmentSecrets(envId: string): MaskedSecret[] {
    const env = this.store.getEnvironment(envId);
    if (!env) {
      throw new AppError("NOT_FOUND", `Environment not found: ${envId}`);
    }
    return this.store.snapshotsForEnvironment(envId).map((s) => ({
      name: s.name,
      level: s.level,
      fingerprint: s.fingerprint,
    }));
  }

  getEnvironmentSnapshot(envId: string): { environment: Environment; snapshot: ResolvedSecret[] } {
    const env = this.store.getEnvironment(envId);
    if (!env) {
      throw new AppError("NOT_FOUND", `Environment not found: ${envId}`);
    }
    const snapshot = this.store.snapshotsForEnvironment(envId).map((s) => ({
      name: s.name,
      level: s.level,
      sourcePath: s.sourcePath,
      declarationId: s.declarationId,
      declarationVersion: s.declarationVersion,
      value: s.value,
      fingerprint: s.fingerprint,
    }));
    return { environment: env, snapshot };
  }

  deleteDeclaration(scopeType: ScopeType, scopeId: string, name: string, runId: string = randomUUID()): void {
    const decl = this.store.getDeclaration(scopeType, scopeId, name);
    if (!decl) {
      throw new AppError("NOT_FOUND", `Declaration not found: ${scopeType}/${scopeId}/${name}`);
    }
    const refs = this.store.activeReferencesForDeclaration(decl.id);
    if (refs.length > 0) {
      this.logger.log({
        runId,
        step: "deleteDeclaration",
        state: { declarationId: decl.id, referencedBy: refs },
        reason: "declaration still referenced by snapshots of active environments",
        outcome: "conflict",
      });
      throw new AppError(
        "CONFLICT_REFERENCED",
        `Declaration ${name} is still referenced by ${refs.length} active environment snapshot(s)`,
        { referencedBy: refs },
      );
    }
    this.store.deleteDeclaration(decl.id);
    this.logger.log({
      runId,
      step: "deleteDeclaration",
      state: { declarationId: decl.id, name },
      reason: "no active references, declaration removed",
      outcome: "ok",
    });
  }

  deleteEnvironment(envId: string, runId: string = randomUUID()): void {
    const env = this.store.getEnvironment(envId);
    if (!env) {
      throw new AppError("NOT_FOUND", `Environment not found: ${envId}`);
    }
    this.store.deleteSnapshotsForEnvironment(envId);
    this.store.markEnvironmentDeleted(envId, new Date().toISOString());
    this.logger.log({
      runId,
      step: "deleteEnvironment",
      state: { envId },
      reason: "snapshots cascaded, environment marked deleted",
      outcome: "ok",
    });
  }

  queryBindings(filter: { envId?: string; name?: string }): BindingRow[] {
    if (!filter.envId && !filter.name) {
      throw new AppError("VALIDATION_ERROR", "Provide at least one of envId or name");
    }
    return this.store.queryBindings(filter);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("VALIDATION_ERROR", `${field} must be a non-empty string`);
  }
}
