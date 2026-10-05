import type { MutationOperator } from '../contract/types.ts';

// Predefined mutation operators. Each entry lists ordered token replacements;
// the engine matches the longest token first so '<=' wins over '<'.
export const OPERATORS: ReadonlyArray<MutationOperator> = [
  {
    type: 'EqualityOperator',
    description: 'Swap strict equality/inequality',
    replacements: [['===', '!=='], ['!==', '===']],
  },
  {
    type: 'ArithmeticOperator',
    description: 'Swap binary arithmetic operator',
    replacements: [['+', '-'], ['-', '+'], ['*', '/']],
  },
  {
    type: 'ConditionalBoundary',
    description: 'Shift relational boundary',
    replacements: [['<=', '<'], ['>=', '>'], ['<', '<='], ['>', '>=']],
  },
  {
    type: 'BooleanLiteral',
    description: 'Flip boolean literal',
    replacements: [['true', 'false'], ['false', 'true']],
  },
];

export const REMOVE_CALL: MutationOperator = {
  type: 'RemoveCall',
  description: 'Delete a standalone function-call statement',
  replacements: [],
};

