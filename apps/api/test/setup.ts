import { afterAll, afterEach, beforeAll } from "vitest";
import mongoose from "mongoose";

// Env must be set before anything imports `config/env.js`.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
process.env.OTP_PROVIDER = "console";
process.env.RATE_LIMIT_ENABLED = "false";

beforeAll(async () => {
  const uri = process.env.SEIKA_TEST_MONGO_URI;
  if (!uri) throw new Error("global-setup did not provide SEIKA_TEST_MONGO_URI");
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  await import("../src/models/index.js"); // register every schema
});

/**
 * Clean slate between cases — the plan's "seed → act → assert → cleanup" loop.
 * Collections are emptied rather than dropped so indexes (the booking-overlap
 * and one-active-session-per-PC guards) survive and keep being enforced.
 */
afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
});
