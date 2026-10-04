import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  type Certificate,
  type ChainValidationResult,
  type Clock,
  type ErrorCategory,
  type KeyStore,
  type ValidatorConfig,
} from '../domain/types.ts';
import { validateChain } from '../core/chainValidator.ts';
import type { CertStore } from '../adapters/sqliteStore.ts';

export interface ServerDeps {
  store: CertStore;
  clock: Clock;
  keyStore: KeyStore;
  config: ValidatorConfig;
}

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 507,
  COMPUTATION_FAILURE: 500,
};

const REQUIRED_CERT_FIELDS = ['id', 'subject', 'issuer', 'notBefore', 'notAfter', 'keyUsage', 'signature'] as const;

function parseCert(raw: unknown, index: number): Certificate {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书不是对象');
  }
  const c = raw as Record<string, unknown>;
  for (const f of REQUIRED_CERT_FIELDS) {
    if (!(f in c)) throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书缺少字段: ' + f);
  }
  if (typeof c.id !== 'string' || typeof c.subject !== 'string' || typeof c.issuer !== 'string'
    || typeof c.notBefore !== 'string' || typeof c.notAfter !== 'string' || typeof c.signature !== 'string') {
    throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书字段类型错误');
  }
  if (!Array.isArray(c.keyUsage) || !c.keyUsage.every((u) => typeof u === 'string')) {
    throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书 keyUsage 必须是字符串数组');
  }
  if (Number.isNaN(Date.parse(c.notBefore)) || Number.isNaN(Date.parse(c.notAfter))) {
    throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书有效期不是合法 ISO-8601 时间');
  }
  if (!/^[0-9a-f]{64}$/.test(c.signature)) {
    throw new AppError('INPUT_ERROR', '第 ' + index + ' 张证书 signature 必须是 64 位十六进制 HMAC-SHA256');
  }
  return c as unknown as Certificate;
}

/** 诊断接口：证书装载、链验证、运行日志重放 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, clock, keyStore, config } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(STATUS_BY_CATEGORY[err.category]).send({
        error: { category: err.category, message: err.message, detail: err.detail ?? null },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    reply.status(500).send({
      error: { category: 'COMPUTATION_FAILURE', message },
    });
  });

  app.get('/health', async () => ({ status: 'ok', now: clock.now().toISOString() }));

  app.post('/certs', async (req) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.certs) || body.certs.length === 0) {
      throw new AppError('INPUT_ERROR', '请求体必须是 { certs: [...] } 且非空');
    }
    if (body.certs.length > 256) {
      throw new AppError('RESOURCE_EXHAUSTED', '单次最多装载 256 张证书');
    }
    const certs = body.certs.map((c, i) => parseCert(c, i));
    if (body.replace === true) store.clearCerts();
    const saved = store.saveCerts(certs);
    return { saved };
  });

  app.get('/certs', async () => ({ certs: store.getCerts() }));

  app.post('/validate', async (req) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body.targetId !== 'string' || body.targetId.length === 0) {
      throw new AppError('INPUT_ERROR', '请求体必须包含非空 targetId');
    }
    const certs = store.getCerts();
    let result: ChainValidationResult;
    try {
      result = validateChain(certs, body.targetId, keyStore, clock, config);
    } catch (err) {
      throw new AppError('COMPUTATION_FAILURE', '链验证内核执行失败: ' + (err instanceof Error ? err.message : String(err)));
    }
    const runId = randomUUID();
    store.recordRun(runId, body.targetId, result);
    return { runId, ...result };
  });

  app.get('/runs', async () => ({ runs: store.listRuns() }));

  app.get('/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    const run = store.getRun(runId);
    if (!run) throw new AppError('INPUT_ERROR', '运行编号不存在: ' + runId);
    return run;
  });

  return app;
}
