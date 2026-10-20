import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

import { as, seedPc, seedPlayer, seedZone, type SeededZone } from "./helpers/factories.js";
import { PricingRule } from "../src/models/PricingRule.js";
import { resolveRate } from "../src/modules/pricing/pricing.service.js";
import { PC } from "../src/models/PC.js";

/**
 * Time-of-day pricing.
 *
 * This decides what a player is charged, so the cases that matter are the
 * ones where a rule could quietly charge the wrong amount: a window that
 * crosses midnight, two rules that both apply, and a rate that changes while
 * someone is already playing.
 */

/** A date at a given local hour, so a window test is not at the mercy of today. */
function at(hour: number, minute = 0, dayOfWeek?: number): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (dayOfWeek != null) d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7));
  return d;
}

async function pcOf(zone: SeededZone) {
  return (await PC.findById(zone.pcId).lean())!;
}

describe("T. Time-of-day pricing", () => {
  beforeEach(async () => {
    await PricingRule.deleteMany({});
  });

  it("with no rules, a PC costs what it always did", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const priced = await resolveRate(await pcOf(zone), at(14));
    expect(priced.rate).toBe(60);
    expect(priced.label).toBeNull();
  });

  it("a happy hour applies inside its window and not outside it", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Happy hour",
      startMinute: 13 * 60,
      endMinute: 17 * 60,
      rate: mongoose.Types.Decimal128.fromString("30.00"),
    });

    const pc = await pcOf(zone);
    expect((await resolveRate(pc, at(12, 59))).rate).toBe(60);
    expect((await resolveRate(pc, at(13, 0))).rate).toBe(30);
    expect((await resolveRate(pc, at(16, 59))).rate).toBe(30);
    // The end is exclusive, so 17:00 is already back to full price.
    expect((await resolveRate(pc, at(17, 0))).rate).toBe(60);
  });

  it("a window that crosses midnight covers both sides of it", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Late night",
      startMinute: 22 * 60,
      endMinute: 2 * 60,
      multiplier: 1.5,
    });

    const pc = await pcOf(zone);
    // 22:00–02:00 is how a zone writes a late rate, and splitting it into two
    // rules is the mistake this exists to prevent.
    expect((await resolveRate(pc, at(21, 59))).rate).toBe(60);
    expect((await resolveRate(pc, at(23, 0))).rate).toBe(90);
    expect((await resolveRate(pc, at(1, 0))).rate).toBe(90);
    expect((await resolveRate(pc, at(2, 0))).rate).toBe(60);
  });

  it("a multiplier is applied to the PC's own rate, not a fixed one", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const vip = await seedPc(zone, { pcNumber: "VIP-01", hourlyRate: 150 });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Half price",
      startMinute: 0,
      endMinute: 0, // all day
      multiplier: 0.5,
    });

    expect((await resolveRate(await pcOf(zone), at(10))).rate).toBe(30);
    const vipPc = (await PC.findById(vip.pcId).lean())!;
    // The point of a multiplier: one rule, and every tier keeps its ratio.
    expect((await resolveRate(vipPc, at(10))).rate).toBe(75);
  });

  it("a rule can be limited to certain days", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Weekend",
      days: [0, 6],
      startMinute: 0,
      endMinute: 0,
      rate: mongoose.Types.Decimal128.fromString("90.00"),
    });

    const pc = await pcOf(zone);
    expect((await resolveRate(pc, at(15, 0, 6))).rate).toBe(90); // Saturday
    expect((await resolveRate(pc, at(15, 0, 3))).rate).toBe(60); // Wednesday
  });

  it("the more specific rule wins when two apply", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const vip = await seedPc(zone, { pcNumber: "VIP-01", hourlyRate: 150, category: "vip" });

    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Everything at night",
      startMinute: 20 * 60,
      endMinute: 23 * 60,
      rate: mongoose.Types.Decimal128.fromString("80.00"),
    });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "VIP at night",
      category: "vip",
      startMinute: 20 * 60,
      endMinute: 23 * 60,
      rate: mongoose.Types.Decimal128.fromString("200.00"),
    });

    const vipPc = (await PC.findById(vip.pcId).lean())!;
    // Without this a zone cannot say "everything is 80 at night, except VIP".
    expect((await resolveRate(vipPc, at(21))).label).toBe("VIP at night");
    expect((await resolveRate(vipPc, at(21))).rate).toBe(200);
    expect((await resolveRate(await pcOf(zone), at(21))).rate).toBe(80);
  });

  it("two equally specific rules give the player the cheaper one", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    for (const [label, rate] of [["Offer A", "40.00"], ["Offer B", "25.00"]] as const) {
      await PricingRule.create({
        zoneId: new mongoose.Types.ObjectId(zone.zoneId),
        label,
        startMinute: 10 * 60,
        endMinute: 12 * 60,
        rate: mongoose.Types.Decimal128.fromString(rate),
      });
    }
    // A zone running two overlapping offers meant the better one, and the
    // alternative is charging more than the sign on the wall says.
    expect((await resolveRate(await pcOf(zone), at(11))).rate).toBe(25);
  });

  it("an inactive rule does nothing", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Off",
      startMinute: 0,
      endMinute: 0,
      rate: mongoose.Types.Decimal128.fromString("10.00"),
      active: false,
    });
    expect((await resolveRate(await pcOf(zone), at(11))).rate).toBe(60);
  });

  it("one zone's rules never reach another zone's PCs", async () => {
    const a = await seedZone({ hourlyRate: 60, name: "Zone A" });
    const b = await seedZone({ hourlyRate: 60, name: "Zone B" });
    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(a.zoneId),
      label: "A only",
      startMinute: 0,
      endMinute: 0,
      rate: mongoose.Types.Decimal128.fromString("10.00"),
    });

    expect((await resolveRate(await pcOf(a), at(11))).rate).toBe(10);
    expect((await resolveRate(await pcOf(b), at(11))).rate).toBe(60);
  });

  it("the session is charged the rule's rate, and keeps it if the rule changes", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "All day half",
      startMinute: 0,
      endMinute: 0,
      rate: mongoose.Types.Decimal128.fromString("30.00"),
    });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: (await import("./helpers/factories.js")).qrFor(zone.pcId) });

    const auth = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", sessionMode: "FIXED_DURATION", selectedMinutes: 60 });

    expect(auth.status).toBe(200);
    // An hour at the rule's rate, not the PC's.
    expect(auth.body.minStartAmount).toBe(30);

    // The rate moves after they are authorised. They keep what they were quoted.
    await PricingRule.updateMany({}, { $set: { rate: mongoose.Types.Decimal128.fromString("90.00") } });
    const session = await as(player.token).get(`/api/sessions/${attach.body.sessionId}`);
    expect(session.body.session.pricingSnapshot.hourlyRate).toBe(30);
  });

  it("a booking is priced for when the slot starts, not when it is booked", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });

    await PricingRule.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      label: "Late night",
      startMinute: 23 * 60,
      endMinute: 1 * 60,
      rate: mongoose.Types.Decimal128.fromString("120.00"),
    });

    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(23, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const res = await as(player.token).post("/api/bookings").send({
      pcId: zone.pcId,
      slotStart: start.toISOString(),
      slotEnd: end.toISOString(),
    });

    expect(res.status).toBe(201);
    // Booked now, at whatever the rate is now — but played at midnight, so
    // the midnight rate is what it costs.
    expect(res.body.amount).toBe(120);
  });
});
