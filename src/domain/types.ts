/** 领域契约：证书、验证结果、错误分类。模块间仅通过这些类型交换数据。 */

export interface Certificate {
  id: string;
  subject: string;
  issuer: string;
  /** ISO-8601 */
  notBefore: string;
  /** ISO-8601；now >= notAfter 视为已过期（恰好到期即过期） */
  notAfter: string;
  keyUsage: string[];
  /** HMAC-SHA256(hex)，由签发者密钥对规范载荷计算 */
  signature: string;
}

export type FailureCode =
  | 'CHAIN_BREAK'               // 找不到上一级签发者证书
  | 'SIGNATURE_INVALID'         // 签名与签发者密钥不匹配
  | 'EXPIRED'                   // now >= notAfter
  | 'NOT_YET_VALID'             // now < notBefore
  | 'SELF_SIGNED_INTERMEDIATE'  // 非根位置出现自签名
  | 'MISSING_KEY_USAGE'         // CA 证书缺少 keyCertSign 用途
  | 'MISSING_ISSUER_KEY'        // 本地密钥库中没有签发者密钥
  | 'CHAIN_TOO_LONG';           // 超过最大链长（成环/资源保护）

export interface ChainLinkResult {
  level: number;                // 0 = 目标证书
  certId: string;
  subject: string;
  issuer: string;
  status: 'ok' | 'failed';
  failureCode?: FailureCode;
  reason?: string;
  remainingDays?: number;
}

export type RenewalSeverity = 'ok' | 'warning' | 'critical' | 'expired';

export interface RenewalAdvice {
  certId: string;
  subject: string;
  remainingDays: number;
  severity: RenewalSeverity;
  message: string;
}

export interface ChainFailure {
  level: number;
  certId: string;
  code: FailureCode;
  reason: string;
}

export interface ChainValidationResult {
  valid: boolean;
  targetId: string;
  evaluatedAt: string;
  chain: ChainLinkResult[];
  failure?: ChainFailure;
  renewals: RenewalAdvice[];
}

/** 服务级错误分类：输入错误 / 状态冲突 / 资源耗尽 / 计算失败，四者必须可区分 */
export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_FAILURE';

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly detail?: unknown;
  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.detail = detail;
  }
}

export interface ValidatorConfig {
  renewalWarningDays: number;
  renewalCriticalDays: number;
  maxChainLength: number;
}

export interface Clock {
  now(): Date;
}

/** 密钥库：按主题名提供 CA 签名密钥（本地合成夹具，非生产密钥） */
export type KeyStore = (subject: string) => string | undefined;
