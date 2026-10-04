import type { Certificate, KeyStore } from '../domain/types.ts';
import { canonicalPayload, signPayload } from '../core/hmac.ts';

/**
 * 本地合成 CA 夹具：固定的主体名与密钥，确定性地生成
 * 根 CA -> 中间 CA -> 终端实体 三级链。与验证内核相互独立，
 * 测试中的期望值不依赖内核输出。
 */

export const FIXTURE_KEYS: Record<string, string> = {
  'Demo Root CA': 'root-hmac-secret-0001',
  'Demo Intermediate CA': 'intermediate-hmac-secret-0002',
};

export const fixtureKeyStore: KeyStore = (subject) => FIXTURE_KEYS[subject];

export const FIXTURE_NOW = '2026-01-15T00:00:00.000Z';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoPlus(baseIso: string, days: number): string {
  return new Date(new Date(baseIso).getTime() + days * DAY_MS).toISOString();
}

export interface CertSpec {
  id: string;
  subject: string;
  issuer: string;
  validFromDays: number;   // 相对基准时间
  validForDays: number;
  keyUsage: string[];
  /** 用指定密钥签名；缺省用签发者密钥（伪造签名场景可覆盖） */
  signWithKey?: string;
}

export function makeCert(spec: CertSpec, baseIso: string = FIXTURE_NOW): Certificate {
  const unsigned = {
    id: spec.id,
    subject: spec.subject,
    issuer: spec.issuer,
    notBefore: isoPlus(baseIso, spec.validFromDays),
    notAfter: isoPlus(baseIso, spec.validFromDays + spec.validForDays),
    keyUsage: spec.keyUsage,
  };
  const key = spec.signWithKey ?? FIXTURE_KEYS[spec.issuer];
  if (!key) throw new Error('夹具缺少签发者密钥: ' + spec.issuer);
  return { ...unsigned, signature: signPayload(canonicalPayload(unsigned), key) };
}

export interface FixtureChain {
  root: Certificate;
  intermediate: Certificate;
  leaf: Certificate;
  all: Certificate[];
}

/** 完整三级链：叶 90 天、中间 365 天、根 3650 天 */
export function buildFullChain(baseIso: string = FIXTURE_NOW): FixtureChain {
  const root = makeCert({
    id: 'cert-root', subject: 'Demo Root CA', issuer: 'Demo Root CA',
    validFromDays: -10, validForDays: 3650, keyUsage: ['keyCertSign', 'cRLSign'],
  }, baseIso);
  const intermediate = makeCert({
    id: 'cert-intermediate', subject: 'Demo Intermediate CA', issuer: 'Demo Root CA',
    validFromDays: -10, validForDays: 365, keyUsage: ['keyCertSign'],
  }, baseIso);
  const leaf = makeCert({
    id: 'cert-leaf', subject: 'service.demo.local', issuer: 'Demo Intermediate CA',
    validFromDays: -10, validForDays: 90, keyUsage: ['digitalSignature', 'keyEncipherment'],
  }, baseIso);
  return { root, intermediate, leaf, all: [leaf, intermediate, root] };
}

/** 断裂链：缺少中间 CA，叶的签发者找不到证书 */
export function buildBrokenChain(baseIso: string = FIXTURE_NOW): Certificate[] {
  const { leaf, root } = buildFullChain(baseIso);
  return [leaf, root];
}

/** 恰好过期链：叶的 notAfter 恰好等于评估时刻 */
export function buildExactlyExpiredChain(baseIso: string = FIXTURE_NOW): Certificate[] {
  const chain = buildFullChain(baseIso);
  const expiredLeaf = makeCert({
    id: 'cert-leaf', subject: 'service.demo.local', issuer: 'Demo Intermediate CA',
    validFromDays: -90, validForDays: 90, // notAfter == baseIso == now
    keyUsage: ['digitalSignature', 'keyEncipherment'],
  }, baseIso);
  return [expiredLeaf, chain.intermediate, chain.root];
}

/** 临近过期链：叶剩余 10 天（触发 warning 阈值 30 天） */
export function buildNearExpiryChain(baseIso: string = FIXTURE_NOW): Certificate[] {
  const chain = buildFullChain(baseIso);
  const nearLeaf = makeCert({
    id: 'cert-leaf', subject: 'service.demo.local', issuer: 'Demo Intermediate CA',
    validFromDays: -80, validForDays: 90, // 剩余 10 天
    keyUsage: ['digitalSignature', 'keyEncipherment'],
  }, baseIso);
  return [nearLeaf, chain.intermediate, chain.root];
}
