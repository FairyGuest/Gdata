import { randomBytes } from 'node:crypto';

// Globally unique short identifier, e.g. "env-7f3a9c2e".
export function newEnvId(): string {
  return 'env-' + randomBytes(4).toString('hex');
}

export function newRunId(): string {
  return 'run-' + randomBytes(4).toString('hex');
}

