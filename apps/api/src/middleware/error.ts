import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../common/errors.js";
import { logger } from "../config/logger.js";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route ${req.method} ${req.path}` } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Mongo duplicate key
  if (typeof err === "object" && err && (err as { code?: number }).code === 11000) {
    res.status(409).json({ error: { code: "DUPLICATE", message: "Resource already exists" } });
    return;
  }
  logger.error("Unhandled error", { err: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
}
