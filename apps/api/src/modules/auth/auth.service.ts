import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { OtpChallenge } from "../../models/OtpChallenge.js";
import { RefreshToken } from "../../models/RefreshToken.js";
import { Player } from "../../models/Player.js";
import { StaffUser } from "../../models/StaffUser.js";
import {
  generateOtp,
  hashOtp,
  verifyOtp,
  randomToken,
  hashToken,
  compareToken,
} from "../../common/otp.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type Subject,
} from "../../common/jwt.js";
import { badRequest, unauthorized, tooManyRequests } from "../../common/errors.js";

const MAX_OTP_ATTEMPTS = 5;

function isEmail(v: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

/** Step 1: create + "send" an OTP. In dev the code is logged (no SMS provider yet). */
export async function requestOtp(identifier: string, audience: Subject = "player") {
  if (!identifier) throw badRequest("identifier (phone or email) required");
  const channel = isEmail(identifier) ? "email" : "phone";
  const code = generateOtp(6);
  const codeHash = await hashOtp(code);
  const expiresAt = new Date(Date.now() + env.otpTtlSeconds * 1000);

  // one active challenge per identifier
  await OtpChallenge.deleteMany({ identifier });
  await OtpChallenge.create({
    identifier,
    channel,
    audience: audience === "staff" ? "staff" : "player",
    codeHash,
    expiresAt,
  });

  // TODO(P5): send via Twilio/Resend/WhatsApp. For now, dev-log.
  if (!env.isProd) logger.info("DEV OTP issued", { identifier, code });

  return { channel, expiresInSeconds: env.otpTtlSeconds, devCode: env.isProd ? undefined : code };
}

/** Step 2: verify OTP → find/create subject → issue tokens. */
export async function verifyOtpAndIssue(
  identifier: string,
  code: string,
  audience: Subject = "player"
) {
  const challenge = await OtpChallenge.findOne({ identifier }).sort({ createdAt: -1 });
  if (!challenge) throw unauthorized("No OTP challenge; request a new code");
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) throw tooManyRequests("Too many attempts");

  const ok = await verifyOtp(code, challenge.codeHash);
  if (!ok) {
    challenge.attempts += 1;
    await challenge.save();
    throw unauthorized("Invalid code");
  }
  await OtpChallenge.deleteMany({ identifier });

  const subjectType: Subject = audience === "staff" ? "staff" : "player";
  const { subjectId, role, zoneId } = await resolveOrCreateSubject(
    subjectType,
    identifier,
    challenge.channel as "phone" | "email"
  );

  return issueTokens({ subjectId, subjectType, role, zoneId });
}

async function resolveOrCreateSubject(
  subjectType: Subject,
  identifier: string,
  channel: "phone" | "email"
): Promise<{ subjectId: string; role?: string; zoneId?: string }> {
  const field = channel === "email" ? "email" : "phone";

  if (subjectType === "staff") {
    const staff = await StaffUser.findOne({ [field]: identifier });
    if (!staff) throw unauthorized("Staff account not found — ask owner to create it");
    return { subjectId: String(staff._id), role: staff.role, zoneId: staff.zoneId ? String(staff.zoneId) : undefined };
  }

  // Player: auto-provision on first verified login.
  let player = await Player.findOne({ [field]: identifier });
  if (!player) {
    const username = `player_${randomToken().slice(0, 8)}`;
    player = await Player.create({
      name: "Player",
      username,
      [field]: identifier,
      otpVerified: true,
    });
  } else if (!player.otpVerified) {
    player.otpVerified = true;
    await player.save();
  }
  return { subjectId: String(player._id) };
}

/** Issues an access token + a rotating refresh token (only the hash is stored). */
export async function issueTokens(params: {
  subjectId: string;
  subjectType: Subject;
  role?: string;
  zoneId?: string;
}) {
  const access = signAccessToken({
    sub: params.subjectId,
    typ: params.subjectType,
    role: params.role,
    zoneId: params.zoneId,
  });

  const raw = randomToken();
  const doc = await RefreshToken.create({
    subjectId: params.subjectId,
    subjectType: params.subjectType,
    tokenHash: await hashToken(raw),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  const refresh = signRefreshToken(String(doc._id) + "." + raw);

  return { accessToken: access, refreshToken: refresh, subjectType: params.subjectType };
}

/** Rotate: validate refresh token, revoke it, issue a fresh pair. */
export async function rotateRefreshToken(refreshToken: string) {
  let jti: string;
  try {
    jti = verifyRefreshToken(refreshToken).jti;
  } catch {
    throw unauthorized("Invalid refresh token");
  }
  const [id, raw] = jti.split(".");
  const doc = await RefreshToken.findById(id);
  if (!doc || doc.revoked || doc.expiresAt < new Date()) throw unauthorized("Refresh token revoked or expired");
  if (!(await compareToken(raw ?? "", doc.tokenHash))) throw unauthorized("Refresh token mismatch");

  doc.revoked = true;
  await doc.save();

  // Re-hydrate role/zone for staff so the new access token stays accurate.
  let role: string | undefined;
  let zoneId: string | undefined;
  if (doc.subjectType === "staff") {
    const staff = await StaffUser.findById(doc.subjectId);
    role = staff?.role;
    zoneId = staff?.zoneId ? String(staff.zoneId) : undefined;
  }
  return issueTokens({ subjectId: doc.subjectId, subjectType: doc.subjectType as Subject, role, zoneId });
}

export async function revokeAllForSubject(subjectId: string) {
  await RefreshToken.updateMany({ subjectId, revoked: false }, { revoked: true });
}
