import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  sub: string;
  jti: string;
  scope: string[];
  iat: number;
  exp: number;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function signHs256(claims: JwtClaims, secret: string): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(header + "." + payload).digest();
  return header + "." + payload + "." + sig.toString("base64url");
}

export type VerifyOutcome =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "bad_payload" };

export function verifyHs256(token: string, secret: string): VerifyOutcome {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return { ok: false, reason: "malformed" };
  }
  const [header, payload, signature] = parts;
  let headerObj: unknown;
  try {
    headerObj = JSON.parse(b64urlDecode(header).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof headerObj !== "object" || headerObj === null ||
    (headerObj as Record<string, unknown>).alg !== "HS256"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expected = createHmac("sha256", secret).update(header + "." + payload).digest();
  const actual = b64urlDecode(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  const c = claims as Record<string, unknown>;
  if (
    typeof c.sub !== "string" || typeof c.jti !== "string" ||
    !Array.isArray(c.scope) || !c.scope.every((s) => typeof s === "string") ||
    typeof c.iat !== "number" || typeof c.exp !== "number"
  ) {
    return { ok: false, reason: "bad_payload" };
  }
  return { ok: true, claims: claims as JwtClaims };
}