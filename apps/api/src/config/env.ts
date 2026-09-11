import dotenv from "dotenv";
dotenv.config();

const isProd = process.env.NODE_ENV === "production";

/**
 * Required secret. In production a missing value is fatal — we never silently
 * fall back to a well-known dev secret, because that would make every JWT
 * forgeable (and every webhook spoofable) on a misconfigured deploy.
 * Outside production the dev fallback keeps `pnpm dev:mem` zero-config.
 */
function secret(key: string, devFallback: string): string {
  const v = process.env[key];
  if (v && v.length > 0) {
    if (isProd && v === devFallback) {
      throw new Error(
        `Refusing to start: ${key} is still set to the development default. Generate a real secret.`
      );
    }
    return v;
  }
  if (isProd) {
    throw new Error(`Refusing to start: ${key} is required in production but was not set.`);
  }
  return devFallback;
}

/** Plain optional env var with a default (non-secret). */
function opt(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  isTest: process.env.NODE_ENV === "test",
  port: parseInt(opt("PORT", "4000"), 10),

  mongoUri: opt("MONGO_URI", "mongodb://localhost:27017/seika?replicaSet=rs0"),
  useMemoryDb: process.env.SEIKA_USE_MEMORY_DB === "true",

  /**
   * Optional. When set, state that must be shared between API instances
   * (rate-limit windows) lives here instead of in one process's memory.
   */
  redisUrl: opt("REDIS_URL", ""),

  /** Error reporting. Absent = no reporting; production warns about that. */
  sentryDsn: opt("SENTRY_DSN", ""),
  /** Git sha or tag, so a crash report names the build it came from. */
  release: opt("SEIKA_RELEASE", "dev"),

  jwtAccessSecret: secret("JWT_ACCESS_SECRET", "dev-access-secret"),
  jwtRefreshSecret: secret("JWT_REFRESH_SECRET", "dev-refresh-secret"),
  jwtAccessTtl: opt("JWT_ACCESS_TTL", "15m"),
  jwtRefreshTtl: opt("JWT_REFRESH_TTL", "30d"),
  otpTtlSeconds: parseInt(opt("OTP_TTL_SECONDS", "300"), 10),

  corsOrigins: opt("CORS_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Rate limiting is decoupled from NODE_ENV so staging exercises the same
   * code path production does (testing plan M7 must be verifiable off-prod).
   * Defaults: on in production, off in local dev, off under test.
   */
  rateLimitEnabled: bool("RATE_LIMIT_ENABLED", isProd),

  /**
   * OTP delivery. `console` only logs the code (dev). Production must name a
   * real provider — otherwise nobody can log in, so we fail fast at boot.
   */
  otp: {
    provider: opt("OTP_PROVIDER", isProd ? "" : "console") as
      | ""
      | "console"
      | "msg91"
      | "twilio"
      | "resend",
    msg91: {
      authKey: opt("MSG91_AUTH_KEY", ""),
      templateId: opt("MSG91_TEMPLATE_ID", ""),
      senderId: opt("MSG91_SENDER_ID", "SEIKA"),
    },
    twilio: {
      accountSid: opt("TWILIO_ACCOUNT_SID", ""),
      authToken: opt("TWILIO_AUTH_TOKEN", ""),
      fromNumber: opt("TWILIO_FROM_NUMBER", ""),
    },
    resend: {
      apiKey: opt("RESEND_API_KEY", ""),
      fromEmail: opt("RESEND_FROM_EMAIL", "no-reply@seika.gg"),
    },
  },

  razorpay: {
    keyId: opt("RAZORPAY_KEY_ID", ""),
    keySecret: opt("RAZORPAY_KEY_SECRET", ""),
    webhookSecret: secret("RAZORPAY_WEBHOOK_SECRET", "dev-webhook-secret"),
    // When keys are absent we run in mock mode (dev): orders are simulated locally.
    get enabled() {
      return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    },
  },
};

/**
 * Boot-time guard for configuration that is only wrong in production. Called
 * from server startup so a misconfigured deploy crashes loudly instead of
 * running insecurely (or running with logins that can never be delivered).
 */
export function assertProductionConfig(): void {
  if (!isProd) return;
  const problems: string[] = [];

  if (!env.otp.provider) {
    problems.push("OTP_PROVIDER is not set — no OTP can be delivered, so no user could log in.");
  }
  if (env.otp.provider === "console") {
    problems.push("OTP_PROVIDER=console is dev-only; set msg91, twilio or resend.");
  }
  if (env.otp.provider === "msg91" && !env.otp.msg91.authKey) {
    problems.push("OTP_PROVIDER=msg91 but MSG91_AUTH_KEY is missing.");
  }
  if (env.otp.provider === "twilio" && !(env.otp.twilio.accountSid && env.otp.twilio.authToken)) {
    problems.push("OTP_PROVIDER=twilio but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are missing.");
  }
  if (env.otp.provider === "resend" && !env.otp.resend.apiKey) {
    problems.push("OTP_PROVIDER=resend but RESEND_API_KEY is missing.");
  }
  if (!env.razorpay.enabled) {
    problems.push("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing — payments would run in mock mode.");
  }
  if (env.mongoUri.includes("localhost") && !env.useMemoryDb) {
    problems.push("MONGO_URI still points at localhost — set the real replica set / Atlas URI.");
  }
  if (env.corsOrigins.some((o) => o.includes("localhost"))) {
    problems.push("CORS_ORIGINS still contains localhost.");
  }

  // Warnings, not refusals: these degrade operations rather than making the
  // deploy unsafe, and a zone should still be able to open its doors.
  const warnings: string[] = [];
  if (!env.sentryDsn) warnings.push("SENTRY_DSN is not set — errors will not be reported.");
  if (!env.redisUrl) {
    warnings.push(
      "REDIS_URL is not set — rate limiting is per-process, so it is ineffective behind a load balancer."
    );
  }
  if (env.release === "dev") warnings.push("SEIKA_RELEASE is 'dev' — crash reports will not name a build.");
  for (const w of warnings) console.warn(JSON.stringify({ level: "warn", msg: w }));

  if (problems.length) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n  - ${problems.join("\n  - ")}`
    );
  }
}
