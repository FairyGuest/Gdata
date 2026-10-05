export interface FastifyRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  raw: unknown;
}
export interface FastifyReply {
  statusCode: number;
  sent: boolean;
  code(n: number): FastifyReply;
  header(k: string, v: string): FastifyReply;
  send(payload?: unknown): void;
}
export type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;
export interface FastifyInstance {
  get(path: string, h: Handler): FastifyInstance;
  post(path: string, h: Handler): FastifyInstance;
  put(path: string, h: Handler): FastifyInstance;
  patch(path: string, h: Handler): FastifyInstance;
  delete(path: string, h: Handler): FastifyInstance;
  setErrorHandler(fn: (err: unknown, req: FastifyRequest, reply: FastifyReply) => unknown): FastifyInstance;
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  close(): Promise<void>;
}
export default function fastify(opts?: { logger?: boolean }): FastifyInstance;
