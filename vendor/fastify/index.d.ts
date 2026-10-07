export interface FastifyRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}
export interface FastifyReply {
  code(n: number): FastifyReply;
  send(payload: unknown): { statusCode: number; payload: unknown };
}
export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
export interface InjectResponse { statusCode: number; body: string; json(): any; }
export interface FastifyInstance {
  get(path: string, h: Handler): void;
  post(path: string, h: Handler): void;
  delete(path: string, h: Handler): void;
  inject(opts: { method: string; url: string; payload?: unknown }): Promise<InjectResponse>;
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  close(): Promise<void>;
}
export default function fastify(): FastifyInstance;

