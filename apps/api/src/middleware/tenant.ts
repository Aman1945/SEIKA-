import type { Request, Response, NextFunction } from "express";
import { forbidden } from "../common/errors.js";

/**
 * Injects tenant (zone) scope from the staff token. Every zone-scoped query
 * should filter by req.tenantZoneId. SUPER_ADMIN may override via ?zoneId=.
 */
export function tenantContext(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.typ === "staff") {
    if (req.auth.role === "SUPER_ADMIN") {
      req.tenantZoneId = (req.query.zoneId as string) || req.auth.zoneId;
    } else {
      req.tenantZoneId = req.auth.zoneId;
      // Prevent cross-tenant access via query override.
      if (req.query.zoneId && req.query.zoneId !== req.auth.zoneId) {
        return next(forbidden("Cross-tenant access denied"));
      }
    }
  }
  next();
}
