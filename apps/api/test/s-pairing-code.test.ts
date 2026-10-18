import { describe, it, expect } from "vitest";

import { as, seedPc, seedPlayer, seedZone } from "./helpers/factories.js";
import { PairingCode } from "../src/models/PairingCode.js";
import { PAIR_CODE_LENGTH } from "../src/common/pairingCode.js";

/**
 * Attaching by typed code.
 *
 * This is a second door onto the same PC, so it has to hold the same line the
 * QR does: it says which PC you are at and nothing more. It must not unlock
 * anything, must not work twice, must not survive its minute, and must not
 * let one zone's code reach another zone's machine.
 */

/** The code the PC is currently showing. */
async function codeOnScreen(pcId: string, ownerToken: string): Promise<string> {
  const res = await as(ownerToken).post(`/api/pcs/${pcId}/qr`).send({});
  expect(res.status).toBe(200);
  return res.body.pairCode as string;
}

describe("S. Attaching with the code on the PC screen", () => {
  it("is digits only, and the length the kiosk is told to show", async () => {
    const zone = await seedZone();
    const code = await codeOnScreen(zone.pcId, zone.ownerToken);
    expect(code).toMatch(new RegExp(`^\\d{${PAIR_CODE_LENGTH}}$`));
  });

  it("attaches the player to that PC, still locked", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const code = await codeOnScreen(zone.pcId, zone.ownerToken);
    const res = await as(player.token).post("/api/sessions/attach-code").send({ code });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING_AUTH");
    // The whole point: identifying the PC is not paying for it.
    expect(res.body.note).toMatch(/locked/i);
  });

  it("spaces and dashes are forgiven — people read these off a screen", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const code = await codeOnScreen(zone.pcId, zone.ownerToken);
    const spaced = `${code.slice(0, 4)} ${code.slice(4, 7)}-${code.slice(7)}`;

    const res = await as(player.token).post("/api/sessions/attach-code").send({ code: spaced });
    expect(res.status).toBe(201);
  });

  it("works exactly once", async () => {
    const zone = await seedZone();
    const first = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const second = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const code = await codeOnScreen(zone.pcId, zone.ownerToken);
    expect((await as(first.token).post("/api/sessions/attach-code").send({ code })).status).toBe(201);

    // Otherwise someone who watched the screen attaches to a seat that is
    // already taken, on a code the first player has already used.
    const reuse = await as(second.token).post("/api/sessions/attach-code").send({ code });
    expect(reuse.status).toBe(400);
  });

  it("an expired code is refused", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const code = await codeOnScreen(zone.pcId, zone.ownerToken);
    // Mongo's TTL monitor is too slow to wait for, and the row surviving is
    // exactly the case worth testing: redemption must check the date itself.
    await PairingCode.updateOne({ code }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await as(player.token).post("/api/sessions/attach-code").send({ code });
    expect(res.status).toBe(400);
  });

  it("refreshing the screen retires the code it was showing", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const old = await codeOnScreen(zone.pcId, zone.ownerToken);
    const current = await codeOnScreen(zone.pcId, zone.ownerToken);
    expect(current).not.toBe(old);

    // A code nobody can see any more must not still open the PC.
    const stale = await as(player.token).post("/api/sessions/attach-code").send({ code: old });
    expect(stale.status).toBe(400);

    expect((await as(player.token).post("/api/sessions/attach-code").send({ code: current })).status).toBe(201);
  });

  it("a wrong code is refused, and says nothing about which codes exist", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const real = await codeOnScreen(zone.pcId, zone.ownerToken);
    const wrong = await as(player.token)
      .post("/api/sessions/attach-code")
      .send({ code: "0".repeat(PAIR_CODE_LENGTH) });
    const short = await as(player.token).post("/api/sessions/attach-code").send({ code: "123" });

    expect(wrong.status).toBe(400);
    expect(short.status).toBe(400);
    // Identical wording, so the response cannot be used to sweep the number
    // space and learn which codes are live.
    expect(wrong.body.error.message).toBe(short.body.error.message);
    expect(real).toBeTruthy();
  });

  it("each PC gets its own code, and a code only opens its own PC", async () => {
    const zone = await seedZone();
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const codeA = await codeOnScreen(zone.pcId, zone.ownerToken);
    const codeB = await codeOnScreen(other.pcId, zone.ownerToken);
    expect(codeA).not.toBe(codeB);

    const res = await as(player.token).post("/api/sessions/attach-code").send({ code: codeB });
    expect(res.status).toBe(201);

    const session = await as(player.token).get(`/api/sessions/${res.body.sessionId}`);
    expect(String(session.body.session.pcId)).toBe(other.pcId);
  });

  it("two players racing the same code: exactly one wins", async () => {
    const zone = await seedZone();
    const a = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const b = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const code = await codeOnScreen(zone.pcId, zone.ownerToken);

    // A read-then-write would let both through and bill two people for one seat.
    const [ra, rb] = await Promise.all([
      as(a.token).post("/api/sessions/attach-code").send({ code }),
      as(b.token).post("/api/sessions/attach-code").send({ code }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 400]);
  });

  it("staff cannot attach with it — this is a player door", async () => {
    const zone = await seedZone();
    const code = await codeOnScreen(zone.pcId, zone.ownerToken);

    const res = await as(zone.ownerToken).post("/api/sessions/attach-code").send({ code });
    expect(res.status).toBe(403);
  });
});
