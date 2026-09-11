import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";

import { env } from "./config/env.js";
import { openApiSpec } from "./config/swagger.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { tenantContext } from "./middleware/tenant.js";
import { optionalAuth } from "./middleware/auth.js";

import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { zoneRouter } from "./modules/zone/zone.routes.js";
import { pcRouter } from "./modules/pc/pc.routes.js";
import { sessionRouter } from "./modules/session/session.routes.js";
import { walletRouter } from "./modules/wallet/wallet.routes.js";
import { bookingRouter } from "./modules/booking/booking.routes.js";
import { paymentRouter } from "./modules/payments/payment.routes.js";
import { leaderboardRouter } from "./modules/leaderboard/leaderboard.routes.js";
import { playerRouter } from "./modules/player/player.routes.js";
import { shopRouter } from "./modules/shop/shop.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { staffRouter } from "./modules/staff/staff.routes.js";
import { notificationRouter } from "./modules/notification/notification.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { announcementRouter } from "./modules/announcement/announcement.routes.js";
import { tournamentRouter } from "./modules/tournament/tournament.routes.js";
import { crossZoneRouter } from "./modules/crosszone/crosszone.routes.js";
import { migrationRouter } from "./modules/migration/migration.routes.js";
import { devRouter } from "./modules/dev/dev.routes.js";

// Register all models.
import "./models/index.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // correct client IP behind Nginx (rate limiting)

  // CSP disabled so the bundled single-file demo client (inline JS/CSS) can run.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  // Capture raw body so payment webhooks can verify HMAC signatures.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  if (!env.isProd) app.use(morgan("dev"));

  // Attach auth claims (if any) then tenant scope for downstream routes.
  app.use(optionalAuth, tenantContext);

  // System
  app.use("/health", healthRouter);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.get("/openapi.json", (_req, res) => res.json(openApiSpec));

  // API v1
  app.use("/api/auth", authRouter);
  app.use("/api/zones", zoneRouter);
  app.use("/api/pcs", pcRouter);
  app.use("/api/sessions", sessionRouter);
  app.use("/api/wallet", walletRouter);
  app.use("/api/bookings", bookingRouter);
  app.use("/api/payments", paymentRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/players", playerRouter);
  app.use("/api/shop", shopRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/notifications", notificationRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/announcements", announcementRouter);
  app.use("/api/tournaments", tournamentRouter);
  app.use("/api/crosszone", crossZoneRouter);
  app.use("/api/migration", migrationRouter);
  if (!env.isProd) app.use("/api/dev", devRouter);

  // Static demo web client (thin frontend — just fetches the API).
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
