// 数据契约：模块间传递的唯一数据形状定义。
// 配置层产出 RouteRule[]，内核消费 RouteRule 并产出 ResolvedResponse，
// 状态适配层持久化 RecordedRequest 与序号计数，诊断层只读暴露。

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** 请求体匹配规则（可选）。exact 为深度相等；contains 要求请求体包含给定子集字段。 */
export interface BodyMatch {
  mode: 'exact' | 'contains';
  expected: unknown;
}

/** 一次模拟响应的定义。 */
export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;          // 对象按 JSON 返回，字符串按 text 返回
  delayMs?: number;        // 响应前延迟
}

/** 一条路由规则。同 method+pattern 可配置多条，按调用序号依次消费。 */
export interface RouteRule {
  id: string;              // 配置层生成：method:pattern（重复时 #n 消歧）
  method: HttpMethod;
  pattern: string;         // 支持 *（单段）与 **（多段）通配
  bodyMatch?: BodyMatch;
  responses: MockResponse[]; // 长度>=1；序号超出后复用最后一个
}

/** 内核解析结果。 */
export interface ResolvedResponse {
  ruleId: string;
  sequence: number;        // 本次命中的调用序号（从 1 开始）
  response: MockResponse;
}

/** 一条请求记录。 */
export interface RecordedRequest {
  seq: number;             // 全局到达顺序，从 1 开始
  method: string;
  path: string;            // 不含 query
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;           // JSON 解析结果或原始字符串
  matchedRuleId: string | null;
  respondedStatus: number | null;
  receivedAt: string;      // ISO 时间
}

/** 诊断接口的统计视图。 */
export interface MockStats {
  totalRequests: number;
  unmatchedRequests: number;
  rules: Array<{ ruleId: string; hits: number }>;
}
