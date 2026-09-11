import type { Request, Response, NextFunction } from "express";
import { forbidden, unauthorized } from "../common/errors.js";
import type { SystemRole } from "../models/enums.js";

/** Requires the staff role to be one of the allowed roles. SUPER_ADMIN always passes. */
export function requireRole(...roles: SystemRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.typ !== "staff") return next(forbidden("Staff only"));
    if (req.auth.role === "SUPER_ADMIN") return next();
    if (!req.auth.role || !roles.includes(req.auth.role as SystemRole)) {
      return next(forbidden("Insufficient role"));
    }
    next();
  };
}

/** Requires the subject to be a player. */
export function requirePlayer(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (req.auth.typ !== "player") return next(forbidden("Players only"));
  next();
}
