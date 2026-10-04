// Contract layer: event body parsing, field validation, seq/type extraction.
// Every malformed input is rejected here with a 422 ContractError before it
// can reach the kernel; the kernel only ever sees well-typed NftEvent values.

export type EventType = 'mint' | 'transfer' | 'sale';

export interface NftEvent {
  seq: number;
  type: EventType;
  tokenId: string;
  from: string | null;
  to: string;
  price: number | null;
}

export class ContractError extends Error {
  readonly status = 422;
  readonly reason = 'invalid_input';
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'ContractError';
    this.detail = detail;
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set(['mint', 'transfer', 'sale']);
const ADDR_RE = /^0x[0-9a-fA-F]{8,64}$/;

function fail(detail: string): never {
  throw new ContractError(detail);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(field + ' must be a non-empty string');
  return value as string;
}

function requireAddress(value: unknown, field: string): string {
  const s = requireString(value, field);
  if (!ADDR_RE.test(s)) fail(field + ' must be a 0x-prefixed hex address, got: ' + s);
  return s;
}

export function parseEvent(body: unknown): NftEvent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('event body must be an object');
  }
  const raw = body as Record<string, unknown>;

  const seq = raw.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    fail('seq must be an integer >= 1');
  }

  const type = requireString(raw.type, 'type');
  if (!EVENT_TYPES.has(type)) fail('type must be one of mint|transfer|sale, got: ' + type);

  const tokenId = requireString(raw.tokenId, 'tokenId');

  const to = requireAddress(raw.to, 'to');

  let from: string | null = null;
  if (raw.from !== null && raw.from !== undefined) {
    from = requireAddress(raw.from, 'from');
  }

  let price: number | null = null;
  if (raw.price !== null && raw.price !== undefined) {
    if (typeof raw.price !== 'number' || !Number.isInteger(raw.price) || raw.price < 0) {
      fail('price must be a non-negative integer');
    }
    price = raw.price;
  }

  if (type === 'mint') {
    if (from !== null) fail('mint must not carry a from address');
    if (price !== null) fail('mint must not carry a price');
  } else if (type === 'transfer') {
    if (from === null) fail('transfer requires a from address');
    if (price !== null) fail('transfer must not carry a price');
  } else {
    if (from === null) fail('sale requires a from address');
    if (price === null) fail('sale requires a price');
  }

  return { seq: seq as number, type: type as EventType, tokenId, from, to, price };
}

// Canonical serialization used to decide whether a re-submitted seq carries
// identical content (idempotent replay) or conflicting content.
export function canonicalEvent(ev: NftEvent): string {
  return JSON.stringify({
    seq: ev.seq,
    type: ev.type,
    tokenId: ev.tokenId,
    from: ev.from,
    to: ev.to,
    price: ev.price,
  });
}
