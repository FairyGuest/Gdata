import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, toAppError } from "../contract/errors.ts";
import { parseCompareRequest, parseUpdateRequest, validateKey } from "../contract/validate.ts";
import type { ApiBody } from "../contract/types.ts";
import type { SnapshotEngine } from "../core/engine.ts";

export interface HttpOptions {
  maxPayloadBytes: number;
}

function send(res: ServerResponse, status: number, body: ApiBody<unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function ok(res: ServerResponse, data: unknown, runId: string | null, status = 200): void {
  send(res, status, { ok: true, runId, data });
}

function fail(res: ServerResponse, err: unknown, runId: string | null): void {
  const appErr = toAppError(err);
  const error: { category: typeof appErr.category; message: string; detail?: unknown } = {
    category: appErr.category,
    message: appErr.message,
  };
  if (appErr.detail !== undefined) error.detail = appErr.detail;
  send(res, appErr.httpStatus, { ok: false, runId, error });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  // Always drain the full request body, even after the limit is exceeded.
  // Responding while the client is still uploading resets the socket and
  // poisons keep-alive connection reuse for subsequent requests.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      exceeded = true;
    } else if (!exceeded) {
      chunks.push(chunk as Buffer);
    }
  }
  if (exceeded) {
    throw new AppError("RESOURCE_EXHAUSTED", "request body exceeds limit", {
      bytes: size,
      limit: maxBytes,
    });
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) throw new AppError("INPUT_ERROR", "request body is empty");
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("INPUT_ERROR", "request body is not valid JSON");
  }
}

export function createHttpServer(engine: SnapshotEngine, opts: HttpOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/health") {
        ok(res, { status: "up" }, null);
        return;
      }
      if (method === "POST" && path === "/snapshots/compare") {
        const body = await readBody(req, opts.maxPayloadBytes);
        const result = engine.compare(parseCompareRequest(body));
        ok(res, result, result.runId, result.status === "created" ? 201 : 200);
        return;
      }
      if (method === "POST" && path === "/snapshots/update") {
        const body = await readBody(req, opts.maxPayloadBytes);
        const result = engine.forceUpdate(parseUpdateRequest(body));
        ok(res, result, result.runId);
        return;
      }
      const snapMatch = path.match(/^\/snapshots\/([^/]+)$/);
      if (snapMatch) {
        const key = validateKey(decodeURIComponent(snapMatch[1] as string));
        if (method === "GET") {
          ok(res, engine.getSnapshot(key), null);
          return;
        }
        if (method === "DELETE") {
          engine.deleteSnapshot(key);
          ok(res, { key, deleted: true }, null);
          return;
        }
      }
      const runMatch = path.match(/^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        ok(res, engine.getRun(runMatch[1] as string), null);
        return;
      }
      if (method === "GET" && path === "/runs") {
        const key = url.searchParams.get("key") ?? undefined;
        ok(res, engine.listRuns(key), null);
        return;
      }
      throw new AppError("INPUT_ERROR", "unknown route", { method, path });
    } catch (err) {
      fail(res, err, null);
    }
  });
}
