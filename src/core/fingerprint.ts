/** Content fingerprints: aggregate hash of a target's watched files. */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function hashFile(absPath: string): string {
  if (!existsSync(absPath)) return 'MISSING';
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * Fingerprint = sha256 over sorted "path:fileHash" lines.
 * Stable regardless of the order paths were declared in.
 */
export function fingerprintPaths(workspaceRoot: string, paths: string[]): string {
  const lines = paths
    .map((p) => `${p}:${hashFile(join(workspaceRoot, p))}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}