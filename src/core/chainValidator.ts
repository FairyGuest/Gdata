import type {
  Certificate,
  ChainLinkResult,
  ChainValidationResult,
  Clock,
  FailureCode,
  KeyStore,
  RenewalAdvice,
  ValidatorConfig,
} from '../domain/types.ts';
import { verifySignature } from './hmac.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function renewalAdvice(cert: Certificate, now: Date, cfg: ValidatorConfig): RenewalAdvice {
  const remainingMs = new Date(cert.notAfter).getTime() - now.getTime();
  const remainingDays = Math.floor(remainingMs / DAY_MS);
  let severity: RenewalAdvice['severity'];
  let message: string;
  if (remainingMs <= 0) {
    severity = 'expired';
    message = '证书 ' + cert.subject + ' 已过期，必须立即续期';
  } else if (remainingDays <= cfg.renewalCriticalDays) {
    severity = 'critical';
    message = '证书 ' + cert.subject + ' 剩余 ' + remainingDays + ' 天（<= ' + cfg.renewalCriticalDays + ' 天），请立即安排续期';
  } else if (remainingDays <= cfg.renewalWarningDays) {
    severity = 'warning';
    message = '证书 ' + cert.subject + ' 剩余 ' + remainingDays + ' 天（<= ' + cfg.renewalWarningDays + ' 天），建议近期续期';
  } else {
    severity = 'ok';
    message = '证书 ' + cert.subject + ' 剩余 ' + remainingDays + ' 天，无需续期';
  }
  return { certId: cert.id, subject: cert.subject, remainingDays, severity, message };
}

/**
 * 执行内核：从目标证书出发沿 issuer->subject 向上走，逐级校验
 * 有效期、签名（HMAC-SHA256）、自签名位置与密钥用途，直到自签名根。
 * 纯函数，不依赖 IO；时间由注入的 Clock 提供。
 */
export function validateChain(
  certs: Certificate[],
  targetId: string,
  keyStore: KeyStore,
  clock: Clock,
  cfg: ValidatorConfig,
): ChainValidationResult {
  const now = clock.now();
  const bySubject = new Map<string, Certificate>();
  for (const c of certs) {
    if (!bySubject.has(c.subject)) bySubject.set(c.subject, c);
  }
  const byId = new Map(certs.map((c) => [c.id, c]));

  const chain: ChainLinkResult[] = [];
  const renewals: RenewalAdvice[] = [];
  const result: ChainValidationResult = {
    valid: false,
    targetId,
    evaluatedAt: now.toISOString(),
    chain,
    renewals,
  };

  const target = byId.get(targetId);
  if (!target) {
    result.failure = {
      level: 0,
      certId: targetId,
      code: 'CHAIN_BREAK',
      reason: '目标证书 ' + targetId + ' 不在提供的证书集合中',
    };
    return result;
  }

  let current: Certificate = target;
  let level = 0;
  const visited = new Set<string>();

  for (;;) {
    if (level >= cfg.maxChainLength || visited.has(current.id)) {
      const link: ChainLinkResult = {
        level, certId: current.id, subject: current.subject, issuer: current.issuer,
        status: 'failed', failureCode: 'CHAIN_TOO_LONG',
        reason: '链长超过上限 ' + cfg.maxChainLength + ' 或检测到环路',
      };
      chain.push(link);
      result.failure = { level, certId: current.id, code: 'CHAIN_TOO_LONG', reason: link.reason! };
      return result;
    }
    visited.add(current.id);

    renewals.push(renewalAdvice(current, now, cfg));
    const remainingDays = Math.floor((new Date(current.notAfter).getTime() - now.getTime()) / DAY_MS);
    const link: ChainLinkResult = {
      level, certId: current.id, subject: current.subject, issuer: current.issuer,
      status: 'ok', remainingDays,
    };
    chain.push(link);

    const markFailed = (code: FailureCode, reason: string): ChainValidationResult => {
      link.status = 'failed';
      link.failureCode = code;
      link.reason = reason;
      result.failure = { level, certId: current.id, code, reason };
      return result;
    };

    // 1) 有效期
    if (now.getTime() < new Date(current.notBefore).getTime()) {
      return markFailed('NOT_YET_VALID', '第 ' + level + ' 级证书 ' + current.subject + ' 尚未生效（notBefore=' + current.notBefore + '）');
    }
    if (now.getTime() >= new Date(current.notAfter).getTime()) {
      return markFailed('EXPIRED', '第 ' + level + ' 级证书 ' + current.subject + ' 已过期（notAfter=' + current.notAfter + '）');
    }

    const selfSigned = current.issuer === current.subject;

    // 2) 目标证书自签名：终端实体不允许自签名
    if (selfSigned && level === 0) {
      return markFailed('SELF_SIGNED_INTERMEDIATE', '目标证书 ' + current.subject + ' 是自签名证书，不能作为终端实体');
    }

    // 3) 签名校验（自签名根用自己的密钥，其余用签发者密钥）
    const keySubject = selfSigned ? current.subject : current.issuer;
    const key = keyStore(keySubject);
    if (!key) {
      return markFailed('MISSING_ISSUER_KEY', '本地密钥库中找不到第 ' + level + ' 级签发者 ' + keySubject + ' 的密钥');
    }
    if (!verifySignature(current, key)) {
      return markFailed('SIGNATURE_INVALID', '第 ' + level + ' 级证书 ' + current.subject + ' 的签名与签发者 ' + keySubject + ' 不匹配');
    }

    // 4) 到达自签名根：链终止
    if (selfSigned) {
      if (!current.keyUsage.includes('keyCertSign')) {
        return markFailed('MISSING_KEY_USAGE', '根证书 ' + current.subject + ' 缺少 keyCertSign 用途');
      }
      result.valid = true;
      return result;
    }

    // 5) 中间 CA 必须具备 keyCertSign
    if (level > 0 && !current.keyUsage.includes('keyCertSign')) {
      return markFailed('MISSING_KEY_USAGE', '第 ' + level + ' 级中间证书 ' + current.subject + ' 缺少 keyCertSign 用途');
    }

    // 6) 向上一级
    const issuer = bySubject.get(current.issuer);
    if (!issuer) {
      return markFailed('CHAIN_BREAK', '第 ' + level + ' 级证书 ' + current.subject + ' 的签发者 ' + current.issuer + ' 的证书缺失，信任链断裂');
    }
    current = issuer;
    level += 1;
  }
}
