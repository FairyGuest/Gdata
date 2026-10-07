// Content fingerprinting: aggregate hash over a target's watched files.
// Missing files are part of the fingerprint so delete/recreate is detected.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function hashFileContent(workspaceRoot: string, relPath: string): string {
  const abs = join(workspaceRoot, relPath);
  if (!existsSync(abs)) return "MISSING";
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/**
 * Aggregate fingerprint of a set of watched paths: sha256 over the sorted
 * list of "path:filehash" lines. Order-independent and path-sensitive.
 */
export function computeFingerprint(workspaceRoot: string, watchPaths: string[]): string {
  const lines = watchPaths
    .map((p) => p + ":" + hashFileContent(workspaceRoot, p))
    .sort()
    .join("\n");
  return createHash("sha256").update(lines).digest("hex");
}
