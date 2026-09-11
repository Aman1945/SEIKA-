import { Router } from "express";
import mongoose from "mongoose";

export const healthRouter = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Liveness + DB connectivity
 */
healthRouter.get("/", (_req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const dbState = states[mongoose.connection.readyState] ?? "unknown";
  res.json({
    ok: true,
    service: "seika-api",
    version: "0.1.0",
    db: dbState,
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});
