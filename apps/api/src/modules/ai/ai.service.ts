import mongoose from "mongoose";
import { Session } from "../../models/Session.js";
import { Player } from "../../models/Player.js";
import { overview } from "../analytics/analytics.service.js";
import { lowStock } from "../shop/shop.service.js";

/**
 * Business insights. Rule-based signals now; an LLM can later turn `signals`
 * into prose via `summarizeWithLlm` (provider-agnostic hook, off by default so
 * it works with zero external keys — same pattern as Razorpay mock mode).
 */
export interface Insight {
  kind: "info" | "opportunity" | "warning";
  title: string;
  detail: string;
}

/** Busiest hours of day over the last 30 days (for dynamic-pricing hints). */
async function peakHours(zoneId: string): Promise<{ hour: number; sessions: number }[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await Session.aggregate([
    { $match: { zoneId: new mongoose.Types.ObjectId(zoneId), startTime: { $gte: since } } },
    { $group: { _id: { $hour: "$startTime" }, sessions: { $sum: 1 } } },
    { $sort: { sessions: -1 } },
    { $limit: 3 },
  ]);
  return rows.map((r) => ({ hour: r._id, sessions: r.sessions }));
}

/** 7-day revenue projection from the last 7 days' completed-session revenue. */
async function revenueForecast(zoneId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await Session.aggregate([
    { $match: { zoneId: new mongoose.Types.ObjectId(zoneId), status: "COMPLETED", endTime: { $gte: since } } },
    { $group: { _id: null, total: { $sum: { $toDecimal: "$cost" } }, days: { $addToSet: { $dayOfYear: "$endTime" } } } },
  ]);
  const total = rows[0] ? parseFloat(rows[0].total.toString()) : 0;
  const activeDays = rows[0]?.days?.length || 1;
  const avgPerDay = +(total / activeDays).toFixed(2);
  return { last7DaysRevenue: total, avgPerDay, next7DaysProjection: +(avgPerDay * 7).toFixed(2) };
}

/** Players with no session in the last 14 days = churn risk. */
async function churnRisk(zoneId: string) {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const zid = new mongoose.Types.ObjectId(zoneId);
  const ever = await Session.distinct("playerId", { zoneId: zid });
  const active = await Session.distinct("playerId", { zoneId: zid, endTime: { $gte: cutoff } });
  const activeSet = new Set(active.map(String));
  const atRisk = ever.filter((p) => !activeSet.has(String(p)));
  return { totalPlayers: ever.length, activeLast14Days: active.length, atRiskCount: atRisk.length };
}

export async function generateInsights(zoneId: string) {
  const [ov, peaks, low, forecast, churn] = await Promise.all([
    overview(zoneId),
    peakHours(zoneId),
    lowStock(zoneId),
    revenueForecast(zoneId),
    churnRisk(zoneId),
  ]);

  const insights: Insight[] = [];

  if (churn.atRiskCount > 0) {
    insights.push({
      kind: "warning",
      title: `${churn.atRiskCount} player(s) at churn risk`,
      detail: `No visit in 14+ days. Send a comeback offer or bonus coins to re-engage.`,
    });
  }

  if (ov.occupancyPct >= 80) {
    insights.push({
      kind: "opportunity",
      title: "High occupancy — consider peak pricing",
      detail: `PCs are ${ov.occupancyPct}% occupied. A peak surcharge during busy hours can lift revenue without hurting demand.`,
    });
  } else if (ov.occupancyPct <= 20 && ov.pcs.total > 0) {
    insights.push({
      kind: "opportunity",
      title: "Low occupancy — run an off-peak offer",
      detail: `Only ${ov.occupancyPct}% of PCs are in use. A happy-hour discount could pull in more players.`,
    });
  }

  if (peaks.length) {
    const top = peaks[0];
    insights.push({
      kind: "info",
      title: "Busiest hour",
      detail: `Most sessions start around ${top.hour}:00 (${top.sessions} in 30 days). Staff and stock accordingly.`,
    });
  }

  for (const p of low) {
    insights.push({
      kind: "warning",
      title: `Low stock: ${p.name}`,
      detail: `${p.name} is down to ${p.stockQty} (threshold ${p.lowStockThreshold}). Restock soon.`,
    });
  }

  if (ov.ordersPending >= 3) {
    insights.push({
      kind: "warning",
      title: "Order queue building up",
      detail: `${ov.ordersPending} orders pending. Check kitchen/counter throughput.`,
    });
  }

  if (!insights.length) {
    insights.push({ kind: "info", title: "All steady", detail: "No anomalies detected today." });
  }

  return {
    generatedAt: new Date().toISOString(),
    signals: { occupancyPct: ov.occupancyPct, revenueToday: ov.revenueToday, peaks, lowStockCount: low.length },
    forecast,
    churn,
    insights,
    // recommendation the dynamic-pricing engine could act on
    dynamicPricingHint:
      ov.occupancyPct >= 80 ? "raise_peak" : ov.occupancyPct <= 20 ? "offer_discount" : "hold",
  };
}
