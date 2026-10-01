import type { DatabaseSync } from "node:sqlite";
import { evolve, TokenState } from "../kernel/evolve.js";
import type { CollectionTemplate } from "../kernel/render.js";
import { conflict, exhausted, invalid } from "../contract/errors.js";

export interface CollectionRow {
  collectionId: string;
  baseName: string;
  description: string;
  maxLevel: number;
  thresholds: number[];
  template: CollectionTemplate;
}

export interface TokenRow extends TokenState {
  collectionId: string;
  tokenId: string;
  version: number;
}

export interface FeedOutcome {
  level: number;
  xp: number;
  consumedXp: number;
  levelsGained: number;
  seq: number;
}

/**
 * Per-token in-process serialization queue. Every feed for the same
 * (collection, token) is appended to a promise chain, so concurrent feeds
 * commit in arrival order and no update is lost.
 */
export class TokenRepository {
  private tokenQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly db: DatabaseSync) {}

  getCollection(collectionId: string): CollectionRow {
    const row = this.db
      .prepare("SELECT * FROM collections WHERE collection_id = ?")
      .get(collectionId) as CollectionDbRow | undefined;
    if (!row) throw conflict("collection_not_found", { collectionId });
    let thresholds: number[];
    let template: CollectionTemplate;
    try {
      thresholds = JSON.parse(row.thresholds_json) as number[];
      template = JSON.parse(row.templates_json) as CollectionTemplate;
    } catch {
      throw invalid("corrupt_collection_fixture", { collectionId });
    }
    return {
      collectionId: row.collection_id,
      baseName: row.base_name,
      description: row.description,
      maxLevel: row.max_level,
      thresholds,
      template,
    };
  }

  getToken(collectionId: string, tokenId: string): TokenRow {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE collection_id = ? AND token_id = ?")
      .get(collectionId, tokenId) as TokenDbRow | undefined;
    if (!row) throw conflict("token_not_found", { collectionId, tokenId });
    return {
      collectionId: row.collection_id,
      tokenId: row.token_id,
      level: row.level,
      xp: row.xp,
      consumedXp: row.consumed_xp,
      version: row.version,
    };
  }

  assertAdmin(collectionId: string, adminId: string): void {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM admins WHERE collection_id = ? AND admin_id = ?")
      .get(collectionId, adminId) as { ok: number } | undefined;
    if (!row) throw conflict("not_collection_admin", { collectionId, adminId });
  }

  private queueKey(collectionId: string, tokenId: string): string {
    return collectionId + "\x1f" + tokenId;
  }

  feed(
    runId: string,
    collectionId: string,
    tokenId: string,
    amount: number,
    maxWaitMs: number,
  ): Promise<FeedOutcome> {
    const k = this.queueKey(collectionId, tokenId);
    const predecessor = this.tokenQueues.get(k) ?? Promise.resolve();

    const job = (async () => {
      let aborted = false;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          aborted = true;
          reject(exhausted("feed_serialization_timeout", { collectionId, tokenId, maxWaitMs }));
        }, maxWaitMs);
      });
      try {
        await Promise.race([predecessorCatch(predecessor), timeout]);
        if (aborted) {
          throw exhausted("feed_serialization_timeout", { collectionId, tokenId, maxWaitMs });
        }
        return this.feedInTransaction(runId, collectionId, tokenId, amount);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    const tail = job.then(
      () => undefined,
      () => undefined,
    );
    this.tokenQueues.set(k, tail);
    tail.then(() => {
      if (this.tokenQueues.get(k) === tail) this.tokenQueues.delete(k);
    });
    return job;
  }

  private feedInTransaction(
    runId: string,
    collectionId: string,
    tokenId: string,
    amount: number,
  ): FeedOutcome {
    const collection = this.getCollection(collectionId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getToken(collectionId, tokenId);
      if (current.level >= collection.maxLevel) {
        this.db.exec("ROLLBACK");
        throw conflict("max_level_reached", {
          collectionId,
          tokenId,
          level: current.level,
          maxLevel: collection.maxLevel,
        });
      }

      const result = evolve(
        { level: current.level, xp: current.xp, consumedXp: current.consumedXp },
        amount,
        { thresholds: collection.thresholds },
      );

      const updated = this.db
        .prepare(`
          UPDATE tokens
             SET level = ?, xp = ?, consumed_xp = ?, version = version + 1
           WHERE collection_id = ? AND token_id = ? AND version = ?
        `)
        .run(
          result.level,
          result.xp,
          result.consumedXp,
          collectionId,
          tokenId,
          current.version,
        );
      if (updated.changes !== 1) {
        this.db.exec("ROLLBACK");
        throw conflict("token_version_conflict", { collectionId, tokenId });
      }

      const info = this.db
        .prepare(`
          INSERT INTO feed_events
            (run_id, collection_id, token_id, amount, from_level, from_xp,
             to_level, to_xp, consumed_delta)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          runId,
          collectionId,
          tokenId,
          amount,
          current.level,
          current.xp,
          result.level,
          result.xp,
          result.consumedXp - current.consumedXp,
        );
      const feedSeq = Number(info.lastInsertRowid);

      if (result.levelsGained > 0) {
        const lvlInsert = this.db.prepare(`
          INSERT INTO level_events
            (run_id, collection_id, token_id, from_level, to_level, threshold_cost, at_feed_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (let i = 1; i < result.levelsTrail.length; i++) {
          const fromLevel = result.levelsTrail[i - 1];
          lvlInsert.run(
            runId,
            collectionId,
            tokenId,
            fromLevel,
            result.levelsTrail[i],
            collection.thresholds[fromLevel - 1],
            feedSeq,
          );
        }
      }

      this.db.exec("COMMIT");
      return {
        level: result.level,
        xp: result.xp,
        consumedXp: result.consumedXp,
        levelsGained: result.levelsGained,
        seq: feedSeq,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // transaction already finished
      }
      throw err;
    }
  }

  reset(
    runId: string,
    collectionId: string,
    tokenId: string,
    adminId: string,
  ): { fromLevel: number; fromXp: number } {
    this.assertAdmin(collectionId, adminId);
    this.getCollection(collectionId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getToken(collectionId, tokenId);
      const updated = this.db
        .prepare(`
          UPDATE tokens SET level = 1, xp = 0, version = version + 1
           WHERE collection_id = ? AND token_id = ? AND version = ?
        `)
        .run(collectionId, tokenId, current.version);
      if (updated.changes !== 1) {
        this.db.exec("ROLLBACK");
        throw conflict("token_version_conflict", { collectionId, tokenId });
      }
      this.db
        .prepare(`
          INSERT INTO reset_events (run_id, collection_id, token_id, admin_id, from_level, from_xp)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(runId, collectionId, tokenId, adminId, current.level, current.xp);
      this.db.exec("COMMIT");
      return { fromLevel: current.level, fromXp: current.xp };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

function predecessorCatch(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    () => undefined,
  );
}

interface CollectionDbRow {
  collection_id: string;
  base_name: string;
  description: string;
  max_level: number;
  thresholds_json: string;
  templates_json: string;
}

interface TokenDbRow {
  collection_id: string;
  token_id: string;
  level: number;
  xp: number;
  consumed_xp: number;
  version: number;
}

