import crypto from "node:crypto";
import { PairingCode } from "../models/PairingCode.js";

/**
 * Issue and redeem the numeric code on a PC's lock screen.
 *
 * It expires on the same one-minute cadence as the QR, so a code photographed
 * off a screen is worthless by the time anyone walks away with it.
 */

/** Same life as the QR — the two are shown together and must agree. */
export const PAIR_CODE_TTL_SECONDS = 60;

/**
 * Ten digits, as specified.
 *
 * Six is what most pairing flows use and is what a player types without
 * error; ten is a longer read off a screen onto a phone. It is one constant
 * either way, and ten is the safer end of the trade, so it stays.
 */
export const PAIR_CODE_LENGTH = 10;

/** Digits only: a player reads this off a screen and types it on a phone. */
function randomDigits(n: number): string {
  let out = "";
  while (out.length < n) {
    // Rejection sampling rather than % 10, which would make 0-5 slightly more
    // likely than 6-9. The bias is small and there is no reason to carry it.
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte < 250) {
        out += String(byte % 10);
        if (out.length === n) break;
      }
    }
  }
  return out;
}

/**
 * A fresh code for a PC.
 *
 * Any code still live for that PC is retired first, so the screen never shows
 * one code while another still works — a stale code left usable is a PC a
 * stranger can attach to from across the room.
 */
export async function issuePairingCode(
  pcId: string,
  zoneId: string
): Promise<{ code: string; expiresInSeconds: number }> {
  await PairingCode.updateMany({ pcId, usedAt: null }, { $set: { usedAt: new Date() } });

  const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_SECONDS * 1000);

  // Collisions are vanishingly unlikely at ten digits, but "unlikely" is not
  // "handled": a duplicate key would otherwise surface as a 500 on a QR
  // refresh, on a PC a player is standing in front of.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomDigits(PAIR_CODE_LENGTH);
    try {
      await PairingCode.create({ code, pcId, zoneId, expiresAt });
      return { code, expiresInSeconds: PAIR_CODE_TTL_SECONDS };
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  throw new Error("Could not allocate a pairing code");
}

/**
 * Redeem a code, returning the PC it belongs to.
 *
 * The claim is a single conditional update rather than a read followed by a
 * write: two players typing the same code at once would both pass a read,
 * and both would attach to one PC.
 */
export async function redeemPairingCode(
  rawCode: string,
  playerId: string
): Promise<{ pcId: string; zoneId: string } | null> {
  const code = String(rawCode ?? "").replace(/\D/g, "");
  if (code.length !== PAIR_CODE_LENGTH) return null;

  const claimed = await PairingCode.findOneAndUpdate(
    { code, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date(), usedBy: playerId } },
    { new: true }
  ).lean();

  if (!claimed) return null;
  return { pcId: String(claimed.pcId), zoneId: String(claimed.zoneId) };
}
