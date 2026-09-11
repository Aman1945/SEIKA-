import mongoose from "mongoose";
import { Session } from "../../models/Session.js";
import { Booking } from "../../models/Booking.js";
import { Order } from "../../models/Order.js";
import { PC } from "../../models/PC.js";
import { WalletLedger } from "../../models/WalletLedger.js";

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
