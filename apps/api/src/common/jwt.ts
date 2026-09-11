import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type Subject = "player" | "staff";

export interface AccessClaims {
  sub: string; // subject id
  typ: Subject; // player | staff
  role?: string; // staff role
  zoneId?: string; // tenant scope for staff
}

export function signAccessToken(claims: AccessClaims): string {
  const options: jwt.SignOptions = {
    expiresIn: env.jwtAccessTtl as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign(claims, env.jwtAccessSecret, options);
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.jwtAccessSecret) as AccessClaims;
}

/** Refresh token carries only an opaque id; we store its hash server-side. */
export function signRefreshToken(tokenId: string): string {
  const options: jwt.SignOptions = {
    expiresIn: env.jwtRefreshTtl as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign({ jti: tokenId }, env.jwtRefreshSecret, options);
}

export function verifyRefreshToken(token: string): { jti: string } {
  return jwt.verify(token, env.jwtRefreshSecret) as { jti: string };
}
