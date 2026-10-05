import type { Mutant } from '../contract/types.ts';
import { ServiceError } from '../contract/errors.ts';

// Apply a mutant to source text. RemoveCall replaces the whole statement span;
// other operators replace the token at [offset, offset+original.length).
export function applyMutant(source: string, mutant: Mutant): string {
  if (mutant.type === 'RemoveCall') {
    const tail = source.slice(mutant.offset);
    const idx = tail.indexOf(mutant.original);
    if (idx === -1 || idx > 8) {
      throw new ServiceError('STATE_CONFLICT', 'Source drifted: RemoveCall span mismatch', { mutant });
    }
    const end = mutant.offset + idx + mutant.original.length;
    return source.slice(0, mutant.offset + idx) + mutant.replacement + source.slice(end);
  }
  if (source.slice(mutant.offset, mutant.offset + mutant.original.length) !== mutant.original) {
    throw new ServiceError('STATE_CONFLICT', 'Source drifted: token mismatch at mutant offset', { mutant });
  }
  return source.slice(0, mutant.offset) + mutant.replacement +
    source.slice(mutant.offset + mutant.original.length);
}

