import http from "node:http";
import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initRealtime } from "./modules/realtime/io.js";

async function main() {
  await connectDb();

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);

  server.listen(env.port, () => {
    logger.info("SEIKA API listening", {
      port: env.port,
      env: env.nodeEnv,
      docs: `http://localhost:${env.port}/docs`,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
