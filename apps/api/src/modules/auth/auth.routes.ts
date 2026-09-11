import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  requestOtp,
  verifyOtpAndIssue,
  rotateRefreshToken,
  revokeAllForSubject,
} from "./auth.service.js";
import { audit } from "../audit/audit.service.js";

export const authRouter = Router();

const audienceSchema = z.enum(["player", "staff"]).default("player");

// Brute-force guards: cap OTP requests + verify attempts per IP.
const otpRequestLimit = rateLimit({ windowMs: 60_000, max: 5, key: "otp-req" });
const otpVerifyLimit = rateLimit({ windowMs: 60_000, max: 10, key: "otp-verify" });

/**
 * @openapi
 * /auth/otp/request:
 *   post:
 *     tags: [Auth]
 *     summary: Request an OTP for a phone or email
 */
authRouter.post(
  "/otp/request",
  otpRequestLimit,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ identifier: z.string().min(3), audience: audienceSchema })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    const result = await requestOtp(body.data.identifier, body.data.audience);
    res.json({ ok: true, ...result });
  })
);

/**
 * @openapi
 * /auth/otp/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify OTP and receive access + refresh tokens
 */
authRouter.post(
  "/otp/verify",
  otpVerifyLimit,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        identifier: z.string().min(3),
        code: z.string().min(4),
        audience: audienceSchema,
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    const tokens = await verifyOtpAndIssue(
      body.data.identifier,
      body.data.code,
      body.data.audience
    );
    res.json({ ok: true, ...tokens });
  })
);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate a refresh token for a new token pair
 */
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const body = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
    if (!body.success) throw badRequest("refreshToken required");
    const tokens = await rotateRefreshToken(body.data.refreshToken);
    res.json({ ok: true, ...tokens });
  })
);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke all refresh tokens for the authenticated subject
 *     security: [{ bearerAuth: [] }]
 */
authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeAllForSubject(req.auth!.sub);
    await audit({
      actorId: req.auth!.sub,
      actorType: req.auth!.typ,
      action: "LOGOUT",
      entityType: "auth",
      entityId: req.auth!.sub,
    });
    res.json({ ok: true });
  })
);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Return the current token claims
 *     security: [{ bearerAuth: [] }]
 */
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, auth: req.auth });
  })
);
