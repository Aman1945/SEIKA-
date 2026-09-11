import mongoose from "mongoose";
import { Session } from "../../models/Session.js";
import { Booking } from "../../models/Booking.js";
import { Order } from "../../models/Order.js";
import { PC } from "../../models/PC.js";
import { WalletLedger } from "../../models/WalletLedger.js";
import { Product } from "../../models/Product.js";
import { Tournament, TournamentRegistration } from "../../models/Tournament.js";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function sumDecimal(model: any, match: Record<string, unknown>, field: string): Promise<number> {
  const rows = await model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $toDecimal: `$${field}` } } } },
  ]);
  return rows[0] ? parseFloat(rows[0].total.toString()) : 0;
}

/** Owner dashboard overview — everything the "today" screen needs, one call. */
export async function overview(zoneId: string) {
  const zid = new mongoose.Types.ObjectId(zoneId);
  const today = startOfToday();

  const [
    sessionRevenue,
    shopRevenue,
    topupsToday,
    activeSessions,
    pcs,
    bookingsToday,
    ordersPending,
  ] = await Promise.all([
    sumDecimal(Session, { zoneId: zid, status: "COMPLETED", endTime: { $gte: today } }, "cost"),
    sumDecimal(Order, { zoneId: zid, status: "delivered", updatedAt: { $gte: today } }, "total"),
    sumDecimal(WalletLedger, { zoneId: zid, type: "TOPUP", createdAt: { $gte: today } }, "amount"),
    Session.countDocuments({ zoneId: zid, status: "ACTIVE" }),
    PC.find({ zoneId: zid }).select("status").lean(),
    Booking.countDocuments({ zoneId: zid, slotStart: { $gte: today } }),
    Order.countDocuments({ zoneId: zid, status: { $in: ["received", "preparing", "ready"] } }),
  ]);

  const total = pcs.length;
  const occupied = pcs.filter((p) => p.status === "OCCUPIED").length;
  const available = pcs.filter((p) => p.status === "AVAILABLE").length;

  return {
    revenueToday: +(sessionRevenue + shopRevenue).toFixed(2),
    breakdown: { sessions: sessionRevenue, shop: shopRevenue },
    topupsToday,
    activeSessions,
    pcs: { total, occupied, available, offline: total - occupied - available },
    occupancyPct: total ? Math.round((occupied / total) * 100) : 0,
    bookingsToday,
    ordersPending,
  };
}

// ─── Deeper analytics (plan L2–L5) ───────────────────────────────────────────

/** Occupancy: peak hours, idle seat-hours, and the busiest/quietest PCs (L2). */
export async function occupancy(zoneId: string, days = 30) {
  const zid = new mongoose.Types.ObjectId(zoneId);
  const since = new Date(Date.now() - days * 86_400_000);
  const match = { zoneId: zid, status: "COMPLETED", endTime: { $gte: since } };

  const [byHour, byPc, pcs] = await Promise.all([
    Session.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $hour: "$startTime" },
          sessions: { $sum: 1 },
          minutes: { $sum: "$validMinutes" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Session.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$pcId",
          sessions: { $sum: 1 },
          minutes: { $sum: "$validMinutes" },
          revenue: { $sum: { $toDecimal: "$cost" } },
        },
      },
    ]),
    PC.find({ zoneId: zid }).select("pcNumber").lean(),
  ]);

  const pcName = new Map(pcs.map((p) => [String(p._id), p.pcNumber as string]));
  const perPc = pcs.map((pc) => {
    const row = byPc.find((b) => String(b._id) === String(pc._id));
    return {
      pcId: String(pc._id),
      pcNumber: pc.pcNumber as string,
      sessions: row?.sessions ?? 0,
      minutes: row?.minutes ?? 0,
      revenue: row ? parseFloat(row.revenue.toString()) : 0,
    };
  });
  perPc.sort((a, b) => b.minutes - a.minutes);

  // Seat-hours that existed minus seat-hours actually played, over the window.
  const openHoursPerDay = 12; // conservative default until zone hours are modelled
  const capacityMinutes = pcs.length * openHoursPerDay * 60 * days;
  const playedMinutes = perPc.reduce((sum, p) => sum + p.minutes, 0);

  return {
    windowDays: days,
    peakHours: [...byHour]
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 3)
      .map((h) => ({ hour: h._id as number, sessions: h.sessions as number })),
    byHour: byHour.map((h) => ({
      hour: h._id as number,
      sessions: h.sessions as number,
      minutes: h.minutes as number,
    })),
    perPc,
    mostUsed: perPc[0] ?? null,
    leastUsed: perPc.length > 1 ? perPc[perPc.length - 1] : null,
    playedMinutes,
    capacityMinutes,
    idleMinutes: Math.max(0, capacityMinutes - playedMinutes),
    utilisationPct: capacityMinutes ? Math.round((playedMinutes / capacityMinutes) * 100) : 0,
    pcName: Object.fromEntries(pcName),
  };
}

/** Players: who plays most, and how many come back (L3). */
export async function playerAnalytics(zoneId: string, days = 30) {
  const zid = new mongoose.Types.ObjectId(zoneId);
  const since = new Date(Date.now() - days * 86_400_000);

  const perPlayer = await Session.aggregate([
    { $match: { zoneId: zid, status: "COMPLETED" } },
    {
      $group: {
        _id: "$playerId",
        sessions: { $sum: 1 },
        minutes: { $sum: "$validMinutes" },
        spend: { $sum: { $toDecimal: "$cost" } },
        firstPlayed: { $min: "$startTime" },
        lastPlayed: { $max: "$endTime" },
      },
    },
    { $lookup: { from: "players", localField: "_id", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $sort: { minutes: -1 } },
  ]);

  const rows = perPlayer.map((r) => ({
    playerId: String(r._id),
    displayName: (r.p.gamerTag ?? r.p.username) as string,
    level: r.p.level as number,
    sessions: r.sessions as number,
    minutes: r.minutes as number,
    spend: parseFloat(r.spend.toString()),
    firstPlayed: r.firstPlayed as Date,
    lastPlayed: r.lastPlayed as Date,
  }));

  // New = first ever session inside the window. Returning = played in the
  // window but had already played before it.
  const newPlayers = rows.filter((r) => r.firstPlayed >= since);
  const activeInWindow = rows.filter((r) => r.lastPlayed >= since);
  const returning = activeInWindow.filter((r) => r.firstPlayed < since);

  return {
    windowDays: days,
    totalPlayers: rows.length,
    activeInWindow: activeInWindow.length,
    newPlayers: newPlayers.length,
    returningPlayers: returning.length,
    retentionPct: activeInWindow.length
      ? Math.round((returning.length / activeInWindow.length) * 100)
      : 0,
    topPlayers: rows.slice(0, 20),
  };
}

/** Shop: revenue, best sellers, and what is running out (L4). */
export async function shopAnalytics(zoneId: string, days = 30) {
  const zid = new mongoose.Types.ObjectId(zoneId);
  const since = new Date(Date.now() - days * 86_400_000);

  const [sold, revenue, lowStockRows] = await Promise.all([
    Order.aggregate([
      { $match: { zoneId: zid, status: "delivered", updatedAt: { $gte: since } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.name" },
          qty: { $sum: "$items.qty" },
          revenue: { $sum: { $multiply: [{ $toDecimal: "$items.price" }, "$items.qty"] } },
        },
      },
      { $sort: { qty: -1 } },
    ]),
    sumDecimal(Order, { zoneId: zid, status: "delivered", updatedAt: { $gte: since } }, "total"),
    Product.find({ zoneId: zid, active: true })
      .select("name stockQty lowStockThreshold")
      .lean(),
  ]);

  const bestSellers = sold.map((s) => ({
    productId: String(s._id),
    name: s.name as string,
    qty: s.qty as number,
    revenue: parseFloat(s.revenue.toString()),
  }));

  return {
    windowDays: days,
    revenue,
    ordersDelivered: await Order.countDocuments({
      zoneId: zid,
      status: "delivered",
      updatedAt: { $gte: since },
    }),
    bestSellers: bestSellers.slice(0, 10),
    slowMovers: [...bestSellers].reverse().slice(0, 5),
    lowStock: lowStockRows
      .filter((p) => p.stockQty <= (p.lowStockThreshold ?? 0))
      .map((p) => ({ name: p.name as string, stockQty: p.stockQty as number })),
  };
}

/** Events: registrations, revenue, and how each zone performed (L5). */
export async function eventAnalytics(zoneId: string) {
  const zid = new mongoose.Types.ObjectId(zoneId);

  // Events this zone hosts, plus cross-zone events it co-hosts.
  const events = await Tournament.find({
    $or: [{ zoneId: zid }, { "participatingZones.zoneId": zid }],
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const regs = await TournamentRegistration.find({
    tournamentId: { $in: events.map((e) => e._id) },
  }).lean();

  const rows = events.map((e) => {
    const mine = regs.filter((r) => String(r.tournamentId) === String(e._id));
    const fee = parseFloat(String(e.entryFee));
    const fromThisZone = mine.filter((r) => String(r.zoneId) === zoneId);
    const settlement = e.settlement as { pool?: number; netByZone?: Record<string, number> } | undefined;

    return {
      tournamentId: String(e._id),
      name: e.name as string,
      game: (e.game ?? null) as string | null,
      status: e.status as string,
      crossZone: Boolean(e.crossZone),
      isHost: String(e.zoneId) === zoneId,
      registrations: mine.length,
      registrationsFromThisZone: fromThisZone.length,
      checkedIn: mine.filter((r) => r.checkedIn).length,
      // Only the fees this zone actually collected are this zone's revenue.
      revenueThisZone: +(fee * fromThisZone.filter((r) => r.paymentStatus === "paid").length).toFixed(2),
      pool: settlement?.pool ?? null,
      netThisZone: settlement?.netByZone?.[zoneId] ?? null,
      verificationStatus: e.verificationStatus as string,
    };
  });

  return {
    totalEvents: rows.length,
    crossZoneEvents: rows.filter((r) => r.crossZone).length,
    completed: rows.filter((r) => r.status === "completed").length,
    totalRegistrations: rows.reduce((s, r) => s + r.registrations, 0),
    revenueThisZone: +rows.reduce((s, r) => s + r.revenueThisZone, 0).toFixed(2),
    events: rows,
  };
}

/** Sessions as CSV rows for export. */
export async function sessionsCsv(zoneId: string, since?: Date): Promise<string> {
  const match: Record<string, unknown> = { zoneId: new mongoose.Types.ObjectId(zoneId) };
  if (since) match.createdAt = { $gte: since };
  const rows = await Session.find(match).sort({ createdAt: -1 }).limit(10000).lean();

  const header = [
    "sessionId",
    "playerId",
    "pcId",
    "status",
    "paymentSource",
    "startTime",
    "endTime",
    "validMinutes",
    "cost",
    "xpAwarded",
  ];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r._id,
      r.playerId,
      r.pcId,
      r.status,
      r.paymentSource ?? "",
      r.startTime?.toISOString() ?? "",
      r.endTime?.toISOString() ?? "",
      r.validMinutes ?? 0,
      r.cost ? parseFloat(String(r.cost)) : 0,
      r.xpAwarded ?? 0,
    ]
      .map(esc)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}
