import { describe, it, expect } from "vitest";

import { as, seedPc, seedPlayer, seedZone } from "./helpers/factories.js";
import { Booking } from "../src/models/Booking.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";

/** A slot starting in an hour, `hours` long. */
function slot(hoursFromNow = 1, hours = 1) {
  const slotStart = new Date(Date.now() + hoursFromNow * 3600_000);
  const slotEnd = new Date(slotStart.getTime() + hours * 3600_000);
  return { slotStart: slotStart.toISOString(), slotEnd: slotEnd.toISOString() };
}

/** Module E — bookings and online reservations (plan §7.E). E1–E5 are P0. */
describe("E. Bookings & online reservations", () => {
  it("E1 — a booking is created with the correct price and an unpaid status", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const res = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(1, 2) });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(120); // 2h at ₹60
    expect(res.body.paymentStatus).not.toBe("paid");
    expect(res.body.qrCode).toBeTruthy();
  });

  it("E2 — paying a booking from the wallet debits it and confirms the booking", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const created = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(1, 1) });

    const pay = await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});
    expect(pay.status).toBe(200);
    expect(pay.body.paymentStatus).toBe("paid");

    expect(await getWalletBalance(player.playerId)).toBe(440);
  });

  it("E2b — a booking cannot be paid twice", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const created = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(1, 1) });
    await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});

    const again = await as(player.token)
      .post(`/api/bookings/${created.body.bookingId}/pay`)
      .send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    // Charged once only.
    expect(await getWalletBalance(player.playerId)).toBe(440);
  });

  it("E3 — check-in with the booking QR links the booking to a session", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    // Slot must be open now for check-in to be inside the window.
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 55 * 60_000);
    const created = await as(player.token).post("/api/bookings").send({
      pcId: zone.pcId,
      slotStart: start.toISOString(),
      slotEnd: end.toISOString(),
    });
    await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});

    const checkin = await as(player.token)
      .post("/api/bookings/checkin")
      .send({ qrCode: created.body.qrCode });

    expect(checkin.status).toBe(200);
    expect(checkin.body.pcId).toBe(zone.pcId);

    const booking = await Booking.findById(created.body.bookingId).lean();
    expect(["checked_in", "confirmed", "completed"]).toContain(String(booking!.status));
  });

  it("E4 — an overlapping booking on the same PC is refused with 409", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const a = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const b = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const window = slot(2, 2);
    const first = await as(a.token).post("/api/bookings").send({ pcId: zone.pcId, ...window });
    expect(first.status).toBe(201);

    // Exactly the same window.
    const clash = await as(b.token).post("/api/bookings").send({ pcId: zone.pcId, ...window });
    expect(clash.status).toBe(409);

    // A partial overlap must clash too — the tail of the first booking.
    const partial = await as(b.token).post("/api/bookings").send({
      pcId: zone.pcId,
      slotStart: new Date(Date.parse(window.slotStart) + 3600_000).toISOString(),
      slotEnd: new Date(Date.parse(window.slotEnd) + 3600_000).toISOString(),
    });
    expect(partial.status).toBe(409);

    expect(await Booking.countDocuments({})).toBe(1);
  });

  it("E4b — the same slot on a different PC is allowed", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const a = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const b = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const window = slot(3, 1);
    expect((await as(a.token).post("/api/bookings").send({ pcId: zone.pcId, ...window })).status).toBe(201);
    expect((await as(b.token).post("/api/bookings").send({ pcId: other.pcId, ...window })).status).toBe(201);
  });

  it("E5 — cancelling a paid booking refunds the wallet", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const created = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(4, 1) });
    await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});
    expect(await getWalletBalance(player.playerId)).toBe(440);

    const cancel = await as(player.token)
      .post(`/api/bookings/${created.body.bookingId}/cancel`)
      .send({});
    expect(cancel.status).toBe(200);
    expect(String(cancel.body.status)).toContain("cancel");

    expect(await getWalletBalance(player.playerId)).toBe(500);
  });

  it("E6 — check-in outside the window is refused", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    // Slot is hours away — far too early to check in.
    const created = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(8, 1) });
    await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});

    const res = await as(player.token)
      .post("/api/bookings/checkin")
      .send({ qrCode: created.body.qrCode });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("E — a player cannot pay for someone else's booking", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const owner = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const stranger = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const created = await as(owner.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(6, 1) });

    // The debit would land on the booking's player, so a stranger must not be
    // able to trigger it.
    const res = await as(stranger.token)
      .post(`/api/bookings/${created.body.bookingId}/pay`)
      .send({});
    expect(res.status).toBe(403);
    expect(await getWalletBalance(owner.playerId)).toBe(500);
  });

  it("E — staff of another zone cannot cancel this zone's booking", async () => {
    const zoneA = await seedZone({ name: "Zone A", hourlyRate: 60 });
    const zoneB = await seedZone({ name: "Zone B", hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zoneA.zoneId });

    const created = await as(player.token)
      .post("/api/bookings")
      .send({ pcId: zoneA.pcId, ...slot(7, 1) });
    await as(player.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});

    // Owner B holds a valid staff token, but for a different tenant.
    const res = await as(zoneB.ownerToken)
      .post(`/api/bookings/${created.body.bookingId}/cancel`)
      .send({});
    expect(res.status).toBe(403);
    expect(await getWalletBalance(player.playerId)).toBe(440);
  });

  it("E — a player cannot cancel someone else's booking", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const owner = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const stranger = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const created = await as(owner.token)
      .post("/api/bookings")
      .send({ pcId: zone.pcId, ...slot(5, 1) });
    await as(owner.token).post(`/api/bookings/${created.body.bookingId}/pay`).send({});

    const res = await as(stranger.token)
      .post(`/api/bookings/${created.body.bookingId}/cancel`)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Nobody got refunded.
    expect(await getWalletBalance(owner.playerId)).toBe(440);
    expect(await getWalletBalance(stranger.playerId)).toBe(500);
  });
});
