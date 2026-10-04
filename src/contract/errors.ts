// 错误契约：所有可预期的失败类别。不得把异常统一吞成成功。
export type ErrorCategory =
  | 'INPUT_ERROR'         // 请求契约不合法（缺字段、版本/范围语法错误、依赖无法解析）
  | 'STATE_CONFLICT'      // 状态冲突（如 scanId 已存在）
  | 'RESOURCE_EXHAUSTED'  // 资源耗尽（节点数/深度超限）
  | 'COMPUTATION_FAILURE';// 计算失败（未预期的内部错误）

export const ERROR_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  COMPUTATION_FAILURE: 500,
};

export class ScanError extends Error {
  readonly category: ErrorCategory;
  readonly details?: unknown;
  constructor(category: ErrorCategory, message: string, details?: unknown) {
    super(message);
    this.name = 'ScanError';
    this.category = category;
    this.details = details;
  }
}

export interface ErrorResponse {
  error: { category: ErrorCategory; message: string; details?: unknown; runId?: string };
}

export function toErrorResponse(err: unknown, runId?: string): { status: number; body: ErrorResponse } {
  if (err instanceof ScanError) {
    return {
      status: ERROR_HTTP_STATUS[err.category],
      body: { error: { category: err.category, message: err.message, details: err.details, runId } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { category: 'COMPUTATION_FAILURE', message, runId } },
  };
}
