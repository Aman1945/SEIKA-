import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

let memoryServer: { stop: () => Promise<unknown> } | null = null;

/**
 * Connects to MongoDB. In dev without Docker, set SEIKA_USE_MEMORY_DB=true to
 * spin up an in-memory replica set (so transactions work).
 */
export async function connectDb(): Promise<void> {
  let uri = env.mongoUri;

  if (env.useMemoryDb) {
    // Lazy import so prod builds don't require the dev dependency.
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri("seika");
    memoryServer = replSet;
    logger.info("Started in-memory MongoDB replica set", { uri });
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  logger.info("MongoDB connected", { db: mongoose.connection.name });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
}

/** Run a function inside a MongoDB transaction (money-safe ops). */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
