import type { ErrorCategory, ErrorPayload } from './types.ts';

/** 统一错误契约：所有模块抛出 MockError，适配层负责映射为 HTTP 响应。 */
export class MockError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details?: unknown;

  constructor(category: ErrorCategory, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MockError';
    this.code = code;
    this.category = category;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return { error: { code: this.code, category: this.category, message: this.message, details: this.details } };
  }
}

/** 错误类别 -> HTTP 状态码（诊断/管理接口）。 */
export function statusForCategory(category: ErrorCategory): number {
  switch (category) {
    case 'INPUT_ERROR': return 400;
    case 'NO_MATCH': return 404;
    case 'STATE_CONFLICT': return 409;
    case 'RESOURCE_EXHAUSTED': return 503;
    case 'COMPUTATION_FAILURE': return 500;
  }
}

export const inputError = (code: string, msg: string, details?: unknown) =>
  new MockError('INPUT_ERROR', code, msg, details);
export const stateConflict = (code: string, msg: string, details?: unknown) =>
  new MockError('STATE_CONFLICT', code, msg, details);
export const resourceExhausted = (code: string, msg: string, details?: unknown) =>
  new MockError('RESOURCE_EXHAUSTED', code, msg, details);
export const computationFailure = (code: string, msg: string, details?: unknown) =>
  new MockError('COMPUTATION_FAILURE', code, msg, details);
