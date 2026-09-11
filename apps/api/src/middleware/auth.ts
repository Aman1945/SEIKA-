import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type AccessClaims } from "../common/jwt.js";
import { unauthorized } from "../common/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      tenantZoneId?: string;
    }
  }
}

/** Requires a valid access token; attaches claims to req.auth. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("Missing bearer token"));
  try {
    req.auth = verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}

/** Optional auth: attaches claims if present, never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.auth = verifyAccessToken(header.slice(7));
    } catch {
      /* ignore */
    }
  }
  next();
}
