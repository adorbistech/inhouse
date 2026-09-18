import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error, "Failed to start inhouse-api");
    process.exit(1);
  }

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "Shutting down inhouse-api");
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error(error, "Error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal error starting inhouse-api: ${String(error)}\n`);
  process.exit(1);
});
