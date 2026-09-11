import http from "node:http";
import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { env, assertProductionConfig } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initRealtime } from "./modules/realtime/io.js";
import { flushObservability, initObservability } from "./config/observability.js";
import { disconnectRedis, redis } from "./config/redis.js";

async function main() {
  // Crash loudly on an unsafe/incomplete production config rather than
  // booting with dev secrets or an OTP channel that cannot deliver.
  assertProductionConfig();

  // Before anything else, so startup failures are reported too.
  initObservability();

  await connectDb();
  redis(); // connect eagerly when configured, so /health can report on it

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
    // Flush pending crash reports before the process goes away, or the last
    // error before a restart is the one you never see.
    await flushObservability();
    await disconnectRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  logger.error("Fatal startup error", { err: err instanceof Error ? err.stack : String(err) });
  const { captureError } = await import("./config/observability.js");
  captureError(err, { route: "startup" });
  await flushObservability();
  process.exit(1);
});
