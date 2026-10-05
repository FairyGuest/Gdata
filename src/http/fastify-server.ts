import type { HttpReply } from './core.ts';

type Handler = (method: string, path: string, body: unknown) => Promise<HttpReply>;

export async function startFastifyServer(handle: Handler, port: number): Promise<{ close: () => Promise<void> }> {
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, typeof body === 'string' && body.length > 0 ? JSON.parse(body) : undefined);
    } catch {
      done(null, { __invalidJson: true });
    }
  });
  app.all('/*', async (req, reply) => {
    if (typeof req.body === 'object' && req.body !== null && (req.body as Record<string, unknown>).__invalidJson) {
      reply.code(400);
      return { error: { category: 'INPUT_ERROR', message: 'request body is not valid JSON', details: null } };
    }
    const url = new URL(req.url, 'http://localhost');
    const result = await handle(req.method, url.pathname, req.body);
    reply.code(result.status);
    return result.body;
  });
  await app.listen({ port });
  return { close: () => app.close() };
}
