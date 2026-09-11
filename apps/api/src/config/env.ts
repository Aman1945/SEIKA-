import dotenv from "dotenv";
dotenv.config();

function req(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  port: parseInt(process.env.PORT ?? "4000", 10),

  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/seika?replicaSet=rs0",
  useMemoryDb: process.env.SEIKA_USE_MEMORY_DB === "true",

  jwtAccessSecret: req("JWT_ACCESS_SECRET", "dev-access-secret"),
  jwtRefreshSecret: req("JWT_REFRESH_SECRET", "dev-refresh-secret"),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? "30d",
  otpTtlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? "300", 10),

  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "dev-webhook-secret",
    // When keys are absent we run in mock mode (dev): orders are simulated locally.
    get enabled() {
      return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    },
  },
};
