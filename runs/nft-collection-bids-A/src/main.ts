import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const built = await buildApp();
  try {
    await built.app.listen({ host: built.config.host, port: built.config.port });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: "listening", host: built.config.host, port: built.config.port, dbPath: built.config.dbPath }));
    const shutdown = async (): Promise<void> => {
      await built.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await built.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
