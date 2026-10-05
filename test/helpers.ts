// Controllable target server used by tests and the acceptance script.
import http from "node:http";

export interface TargetServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  counts: Record<string, number>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startTarget(): Promise<TargetServer> {
  const counts: Record<string, number> = {};
  let flakyN = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
    void (async () => {
      if (url.pathname === "/ok") {
        const ms = Number(url.searchParams.get("ms") ?? 0);
        if (ms > 0) await sleep(ms);
        res.writeHead(200).end("ok");
      } else if (url.pathname === "/status") {
        res.writeHead(Number(url.searchParams.get("code") ?? 500)).end("st");
      } else if (url.pathname === "/flaky") {
        // Deterministic alternation: even hits 200, odd hits 500.
        flakyN++;
        res.writeHead(flakyN % 2 === 1 ? 200 : 500).end("flaky");
      } else if (url.pathname === "/slow") {
        await sleep(Number(url.searchParams.get("ms") ?? 500));
        res.writeHead(200).end("slow");
      } else if (url.pathname === "/seqdelay") {
        // concurrency=1 only: k-th request sleeps k*step ms (1-based).
        const step = Number(url.searchParams.get("step") ?? 10);
        const k = counts["/seqdelay"];
        await sleep(k * step);
        res.writeHead(200).end("d");
      } else {
        res.writeHead(404).end("nf");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    counts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
