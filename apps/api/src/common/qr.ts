import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/** Short-lived QR token bound to a PC. Player scans it to attach to the PC. */
const QR_TTL_SECONDS = 60;

export function signQrToken(pcId: string): { token: string; expiresInSeconds: number } {
  const token = jwt.sign({ pcId, purpose: "qr" }, env.jwtAccessSecret, {
    expiresIn: QR_TTL_SECONDS,
  });
  return { token, expiresInSeconds: QR_TTL_SECONDS };
}

export function verifyQrToken(token: string): { pcId: string } {
  const decoded = jwt.verify(token, env.jwtAccessSecret) as { pcId: string; purpose: string };
  if (decoded.purpose !== "qr") throw new Error("Not a QR token");
  return { pcId: decoded.pcId };
}
