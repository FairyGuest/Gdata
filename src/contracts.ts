/**
 * 模块间共享的数据与错误契约。
 * 所有跨模块传递的结果与错误都必须使用这里定义的类型。
 */

/** 测试用例最终状态 */
export type CaseStatus = 'passed' | 'failed' | 'timeout';

/** 失败类别：断言失败 / 运行时异常 / 进程崩溃 / 超时 */
export type FailureKind = 'assertion' | 'runtime' | 'crash' | 'timeout';

export interface CaseResult {
  file: string;
  case: string;
  status: CaseStatus;
  failureKind?: FailureKind;
  /** 失败时的错误信息（断言消息或异常堆栈首行） */
  error?: string;
  /** 实际耗时（毫秒），超时时为被终止时的耗时 */
  durationMs: number;
  /** 判定理由，用于日志重放 */
  reason: string;
}

export type RunStatus = 'passed' | 'failed' | 'partial';

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  timeout: number;
  status: RunStatus;
  results: CaseResult[];
  /** 关键中间状态与判断理由，按时间顺序记录 */
  logs: string[];
}

export interface RunRequest {
  dir: string;
  pattern?: string;
  parallel?: boolean;
  concurrency?: number;
  timeoutMs?: number;
}

/** 错误码：输入错误 / 状态冲突 / 资源耗尽 / 计算失败 可区分 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'EXECUTION_FAILED'
  | 'INTERNAL';

export class RunnerError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export const invalidInput = (msg: string) => new RunnerError('INVALID_INPUT', msg, 400);
export const notFound = (msg: string) => new RunnerError('NOT_FOUND', msg, 404);
export const stateConflict = (msg: string) => new RunnerError('STATE_CONFLICT', msg, 409);
export const resourceExhausted = (msg: string) => new RunnerError('RESOURCE_EXHAUSTED', msg, 429);
export const executionFailed = (msg: string) => new RunnerError('EXECUTION_FAILED', msg, 502);