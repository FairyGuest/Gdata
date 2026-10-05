import { buildApp } from "./app.ts";

const app = await buildApp();
await app.adapter.listen(app.config.port, app.config.host);
process.stdout.write(
  JSON.stringify({ event: "listening", adapter: app.adapter.kind, host: app.config.host, port: app.config.port }) + "\n"
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
