import { AuditError } from "../contract/errors";
import {
  AppendRequest,
  AppendResult,
  LogEntry,
  VerifyReport,
  GENESIS_PREV_HASH,
} from "../contract/types";
import { computeEntryHash } from "../core/hash";
import { verifyEntries } from "../core/chain";
import { SqliteAuditStore } from "../state/sqliteStore";
import { ServiceConfig } from "../config";

export class AuditService {
  constructor(
    private store: SqliteAuditStore,
    private config: ServiceConfig
  ) {}

  append(req: AppendRequest): AppendResult {
    if (!req || typeof req.eventType !== "string" || req.eventType.length === 0) {
      throw new AuditError(
        "INPUT_VALIDATION",
        "eventType must be a non-empty string"
      );
    }
    if (req.eventType.length > 128) {
      throw new AuditError("INPUT_VALIDATION", "eventType too long (max 128)");
    }
    if (req.payload === undefined) {
      throw new AuditError("INPUT_VALIDATION", "payload is required");
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(req.payload), "utf8");
    if (payloadBytes > this.config.maxPayloadBytes) {
      throw new AuditError(
        "RESOURCE_EXHAUSTED",
        "payload of " + payloadBytes + " bytes exceeds limit " + this.config.maxPayloadBytes,
        { payloadBytes, limit: this.config.maxPayloadBytes }
      );
    }
    if (this.store.count() >= this.config.maxEntries) {
      throw new AuditError(
        "RESOURCE_EXHAUSTED",
        "entry limit " + this.config.maxEntries + " reached",
        { limit: this.config.maxEntries }
      );
    }
    const timestamp = req.timestamp ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(timestamp))) {
      throw new AuditError(
        "INPUT_VALIDATION",
        "timestamp is not a valid date: " + timestamp
      );
    }

    const last = this.store.lastEntry();
    const seq = last ? last.seq + 1 : 1;
    const prevHash = last ? last.hash : GENESIS_PREV_HASH;
    const hash = computeEntryHash({
      seq,
      timestamp,
      eventType: req.eventType,
      payload: req.payload,
      prevHash,
    });
    const entry: LogEntry = {
      seq,
      timestamp,
      eventType: req.eventType,
      payload: req.payload,
      prevHash,
      hash,
    };
    this.store.append(entry);
    return { seq, hash, prevHash };
  }

  verify(): VerifyReport {
    return verifyEntries(this.store.allEntries());
  }

  list(): LogEntry[] {
    return this.store.allEntries();
  }
}

