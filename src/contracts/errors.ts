// 错误契约：所有模块抛出的可分类错误。诊断层据此映射 HTTP 状态码，
// 测试据此断言失败类别。禁止把未知异常吞成成功。

export type ErrorCategory =
  | 'INPUT_ERROR'         // 输入错误：配置非法、请求格式错误
  | 'STATE_CONFLICT'      // 状态冲突：如重复注册同 id 规则
  | 'RESOURCE_EXHAUSTED'  // 资源耗尽：记录数/延迟超过上限
  | 'EXECUTION_FAILURE';  // 计算失败：内核执行期未预期错误

export class MockServerError extends Error {
  readonly category: ErrorCategory;
  readonly detail?: unknown;
  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = 'MockServerError';
    this.category = category;
    this.detail = detail;
  }
}

export const inputError = (msg: string, detail?: unknown) =>
  new MockServerError('INPUT_ERROR', msg, detail);
export const stateConflict = (msg: string, detail?: unknown) =>
  new MockServerError('STATE_CONFLICT', msg, detail);
export const resourceExhausted = (msg: string, detail?: unknown) =>
  new MockServerError('RESOURCE_EXHAUSTED', msg, detail);
export const executionFailure = (msg: string, detail?: unknown) =>
  new MockServerError('EXECUTION_FAILURE', msg, detail);

export function categoryToHttpStatus(c: ErrorCategory): number {
  switch (c) {
    case 'INPUT_ERROR': return 400;
    case 'STATE_CONFLICT': return 409;
    case 'RESOURCE_EXHAUSTED': return 507;
    case 'EXECUTION_FAILURE': return 500;
  }
}
