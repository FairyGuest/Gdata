import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import {
  keyExpired,
  keyNotFound,
  quotaExhausted,
  rotationConflict,
  validationError,
} from "./errors.ts";
import type { RunLogger } from "./logger.ts";
import { Store, type KeyRow, type ScopeRow, type Tier } from "./store.ts";

export interface TierBalance {
  tier: Tier;
  scopeId: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface ConsumeResult {
  key: string;
  amount: number;
  balances: TierBalance[];
}

export interface RotateResult {
  oldKey: string;
  newKey: string;
  graceUntil: number;
}

export interface UsageResult {
  key: string;
  status: KeyRow["status"];
  consumedTotal: number;
  scopes: TierBalance[];
}

export interface ProvisionInput {
  key: string;
  scopes: { tier: Tier; id: string; limit: number }[];
}

function balanceOf(scope: ScopeRow): TierBalance {
  return {
    tier: scope.tier,
    scopeId: scope.id,
    limit: scope.quota_limit,
    used: scope.quota_used,
    remaining: scope.quota_limit - scope.quota_used,
  };
}

/**
 * Execution kernel. Pure business logic over the Store; no HTTP, no config.
 * Every public method logs its decision and reason through the RunLogger.
 */
export class QuotaKernel {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly logger: RunLogger,
  ) {}

  /** Provisions a key bound to a global/org/project scope chain (synthetic fixture data). */
  provisionKey(input: ProvisionInput): void {
    if (this.store.findKeyByValue(input.key)) {
      throw validationError(`key already exists: ${input.key}`, { key: input.key });
    }
    const byTier = new Map(input.scopes.map((s) => [s.tier, s]));
    for (const tier of ["global", "org", "project"] as const) {
      if (!byTier.has(tier)) {
        throw validationError(`missing ${tier} scope in provision request`);
      }
    }
    this.store.transaction(() => {
      for (const s of input.scopes) {
        if (!this.store.getScope(s.id)) {
          this.store.insertScope({ id: s.id, tier: s.tier, quota_limit: s.limit, quota_used: 0 });
        }
      }
      this.store.insertKey({
        id: randomUUID(),
        key_value: input.key,
        global_scope_id: byTier.get("global")!.id,
        org_scope_id: byTier.get("org")!.id,
        project_scope_id: byTier.get("project")!.id,
        status: "active",
        created_at: this.clock.now(),
        grace_until: null,
        successor_id: null,
        consumed_total: 0,
      });
    });
    this.logger.log({
      op: "provision",
      decision: "ok",
      reason: "key provisioned with 3-tier scope chain",
      state: { key: input.key, scopes: input.scopes },
    });
  }

  private requireUsableKey(keyValue: string): KeyRow {
    const row = this.store.findKeyByValue(keyValue);
    if (!row) throw keyNotFound(keyValue);
    if (row.status === "rotated") {
      const now = this.clock.now();
      if (row.grace_until === null || now > row.grace_until) {
        throw keyExpired(keyValue, row.grace_until ?? -1, now);
      }
    }
    return row;
  }

  private scopeChain(row: KeyRow): ScopeRow[] {
    return [
      this.store.getScope(row.global_scope_id)!,
      this.store.getScope(row.org_scope_id)!,
      this.store.getScope(row.project_scope_id)!,
    ];
  }

  /**
   * Atomically deducts `amount` from all three tiers. If any tier lacks
   * budget the whole transaction rolls back: no partial deduction state can
   * ever be observed.
   */
  consume(keyValue: string, amount: number): ConsumeResult {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw validationError("amount must be a positive integer", { amount });
    }
    const result = this.store.transaction(() => {
      const key = this.requireUsableKey(keyValue);
      const chain = this.scopeChain(key);
      for (const scope of chain) {
        const remaining = scope.quota_limit - scope.quota_used;
        if (remaining < amount) {
          throw quotaExhausted(scope.tier, scope.id, amount, remaining);
        }
      }
      for (const scope of chain) {
        this.store.deductScope(scope.id, amount);
      }
      this.store.addKeyConsumption(key.id, amount);
      return {
        key: keyValue,
        amount,
        balances: this.scopeChain(key).map(balanceOf),
      };
    });
    this.logger.log({
      op: "consume",
      decision: "ok",
      reason: "all three tiers had sufficient budget; deducted atomically",
      state: { key: keyValue, amount, balances: result.balances },
    });
    return result;
  }

  /**
   * Rotates a key: issues a successor bound to the same scope chain and puts
   * the old key into its grace window. Within the window the old key still
   * works; afterwards it fails with KEY_EXPIRED.
   */
  rotate(keyValue: string, graceMs: number): RotateResult {
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw validationError("graceMs must be a non-negative integer", { graceMs });
    }
    const newKeyValue = `ak_${randomUUID().replaceAll("-", "")}`;
    const result = this.store.transaction(() => {
      const old = this.store.findKeyByValue(keyValue);
      if (!old) throw keyNotFound(keyValue);
      if (old.status !== "active") {
        throw rotationConflict(keyValue, "key was already rotated");
      }
      const graceUntil = this.clock.now() + graceMs;
      const successorId = randomUUID();
      this.store.insertKey({
        id: successorId,
        key_value: newKeyValue,
        global_scope_id: old.global_scope_id,
        org_scope_id: old.org_scope_id,
        project_scope_id: old.project_scope_id,
        status: "active",
        created_at: this.clock.now(),
        grace_until: null,
        successor_id: null,
        consumed_total: 0,
      });
      this.store.markRotated(old.id, graceUntil, successorId);
      return { oldKey: keyValue, newKey: newKeyValue, graceUntil };
    });
    this.logger.log({
      op: "rotate",
      decision: "ok",
      reason: `successor issued; old key valid until ${result.graceUntil}`,
      state: result,
    });
    return result;
  }

  /** Per-key usage plus the live balances of its scope chain. */
  usage(keyValue: string): UsageResult {
    const row = this.store.findKeyByValue(keyValue);
    if (!row) throw keyNotFound(keyValue);
    const result: UsageResult = {
      key: keyValue,
      status: row.status,
      consumedTotal: row.consumed_total,
      scopes: this.scopeChain(row).map(balanceOf),
    };
    this.logger.log({
      op: "usage",
      decision: "ok",
      reason: "usage snapshot read",
      state: result as unknown as Record<string, unknown>,
    });
    return result;
  }
}
