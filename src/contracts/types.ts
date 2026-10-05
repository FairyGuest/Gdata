/** 数据契约：跨模块共享的类型定义。 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*';

/** 单个模拟响应。 */
export interface MockResponse {
  status?: number;            // 默认 200
  headers?: Record<string, string>;
  body?: unknown;             // 对象按 JSON 返回，字符串原样返回
  delayMs?: number;           // 响应前延迟
}

/** 请求体匹配规则（全部满足才算命中）。 */
export interface BodyMatch {
  equals?: string;            // 原始体完全相等
  contains?: string;          // 原始体包含子串
  json?: Record<string, unknown>; // JSON 体的部分深匹配
}

/** 路由规则。 */
export interface RouteConfig {
  id?: string;
  method: HttpMethod;
  path: string;               // 支持 *（单段）与 **（跨段）通配
  bodyMatch?: BodyMatch;
  responses: MockResponse[];  // 按调用序号依次返回
  onExhausted?: 'error' | 'repeat-last'; // 默认 'error'
}

/** 一条请求记录。 */
export interface RequestRecord {
  seq: number;                // 全局单调递增，代表调用顺序
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  routeId: string | null;     // 命中的路由；未命中为 null
  matched: boolean;
  receivedAt: string;         // ISO 时间
}

/** 路由运行时状态。 */
export interface RouteState {
  routeId: string;
  callCount: number;
}

/** 诊断接口统一错误载荷。 */
export interface ErrorPayload {
  error: {
    code: string;
    category: ErrorCategory;
    message: string;
    details?: unknown;
  };
}

export type ErrorCategory =
  | 'INPUT_ERROR'         // 输入非法（配置、请求参数）
  | 'NO_MATCH'            // 无路由命中
  | 'STATE_CONFLICT'      // 状态冲突（序号耗尽、重复注册）
  | 'RESOURCE_EXHAUSTED'  // 资源耗尽（记录容量超限）
  | 'COMPUTATION_FAILURE';// 内部计算失败（正则、序列化等）
