import { createHash } from "node:crypto";
import { AppError } from "./errors.ts";
import type {
  ResolvedSecret,
  ScopeType,
  SecretDeclaration,
} from "./types.ts";

export function fingerprint(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

export interface ScopeChainEntry {
  scopeType: ScopeType;
  scopeId: string;
}

export function sourcePath(chain: ScopeChainEntry[], level: ScopeType): string {
  const parts: string[] = [];
  for (const entry of chain) {
    parts.push(`${entry.scopeType}:${entry.scopeId}`);
    if (entry.scopeType === level) break;
  }
  return parts.join("/");
}

/**
 * Pure resolution kernel: nearest-scope override, decided independently per key.
 * Chain is ordered org -> project -> env; later (deeper) scopes win.
 */
export function resolveSecrets(
  requiredNames: string[],
  chain: ScopeChainEntry[],
  declarations: SecretDeclaration[],
  fingerprintLength: number,
): ResolvedSecret[] {
  const byName = new Map<string, SecretDeclaration>();
  for (const entry of chain) {
    for (const decl of declarations) {
      if (decl.scopeType === entry.scopeType && decl.scopeId === entry.scopeId) {
        byName.set(decl.name, decl); // deeper scopes overwrite shallower ones
      }
    }
  }
  const missing = requiredNames.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new AppError(
      "MISSING_SECRETS",
      `Required secrets are not declared at any scope: ${missing.join(", ")}`,
      { missing },
    );
  }
  return requiredNames.map((name) => {
    const decl = byName.get(name)!;
    return {
      name,
      level: decl.scopeType,
      sourcePath: sourcePath(chain, decl.scopeType),
      declarationId: decl.id,
      declarationVersion: decl.version,
      value: decl.value,
      fingerprint: fingerprint(decl.value, fingerprintLength),
    };
  });
}
