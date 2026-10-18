import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../common/errors.js";
import { logger } from "../config/logger.js";
import { captureError } from "../config/observability.js";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route ${req.method} ${req.path}` } });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Body-parser rejections are the client's problem, not ours: a 500 here
  // tells a caller to retry something that will never succeed.
  const parseErr = err as { type?: string; status?: number; statusCode?: number };
  if (parseErr?.type === "entity.too.large") {
    res.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    });
    return;
  }
  if (parseErr?.type === "entity.parse.failed") {
    res.status(400).json({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
    });
    return;
  }

  // A malformed id in the path. Mongoose throws CastError from findById, and
  // without this every /api/<thing>/not-an-id answers 500 — which reads as a
  // server fault, is logged as a bug, and buries the real ones. It also
  // misleads: GET /api/sessions/history looked like a broken endpoint when the
  // route is /history/list and "history" was being cast to an ObjectId.
  const castErr = err as { name?: string; path?: string; kind?: string };
  if (castErr?.name === "CastError") {
    res.status(400).json({
      error: {
        code: "INVALID_ID",
        message: `"${String((err as { value?: unknown }).value ?? "")}" is not a valid ${castErr.path ?? "id"}`,
      },
    });
    return;
  }

  // Mongo duplicate key
  if (typeof err === "object" && err && (err as { code?: number }).code === 11000) {
    res.status(409).json({ error: { code: "DUPLICATE", message: "Resource already exists" } });
    return;
  }
  // Anything reaching here is a bug, not a client mistake, so it is reported.
  logger.error("Unhandled error", {
    err: err instanceof Error ? err.stack : String(err),
    route: `${req.method} ${req.path}`,
  });
  captureError(err, {
    route: `${req.method} ${req.path}`,
    actorId: req.auth?.sub,
    actorType: req.auth?.typ,
  });
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
}
