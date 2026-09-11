import mongoose from "mongoose";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { Session } from "../../models/Session.js";
import { Order } from "../../models/Order.js";
import { Booking } from "../../models/Booking.js";
import { WalletLedger } from "../../models/WalletLedger.js";
import { Zone } from "../../models/Zone.js";
import { badRequest } from "../../common/errors.js";
import { eventAnalytics, playerAnalytics, shopAnalytics } from "./analytics.service.js";

export const EXPORT_TYPES = ["sessions", "revenue", "players", "shop", "bookings", "events"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A dataset ready to render into any of the three formats. */
export interface Dataset {
  title: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, unknown>[];
  /** Headline figures printed above the table in PDF and Excel. */
  summary?: { label: string; value: string }[];
}

const num = (v: unknown) => (v == null ? 0 : parseFloat(String(v)));
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : "");

/** Builds one dataset. Every query is scoped to the caller's own zone. */
export async function buildDataset(params: {
  type: ExportType;
  zoneId: string;
  since?: Date;
  until?: Date;
}): Promise<Dataset> {
  const zid = new mongoose.Types.ObjectId(params.zoneId);
  const range: Record<string, unknown> = {};
  if (params.since) range.$gte = params.since;
  if (params.until) range.$lte = params.until;
  const hasRange = Object.keys(range).length > 0;

  switch (params.type) {
    case "sessions": {
      const match: Record<string, unknown> = { zoneId: zid };
      if (hasRange) match.createdAt = range;
      const rows = await Session.find(match).sort({ createdAt: -1 }).limit(10_000).lean();
      const revenue = rows.reduce((s, r) => s + num(r.cost), 0);
      return {
        title: "Sessions",
        columns: [
          { key: "sessionId", label: "Session ID" },
          { key: "playerId", label: "Player ID" },
          { key: "pcId", label: "PC ID" },
          { key: "game", label: "Game" },
          { key: "status", label: "Status" },
          { key: "paymentSource", label: "Payment" },
          { key: "mode", label: "Mode" },
          { key: "startTime", label: "Start" },
          { key: "endTime", label: "End" },
          { key: "validMinutes", label: "Valid min", numeric: true },
          { key: "cost", label: "Cost", numeric: true },
          { key: "xpAwarded", label: "XP", numeric: true },
        ],
        summary: [
          { label: "Sessions", value: String(rows.length) },
          { label: "Revenue", value: `₹${revenue.toFixed(2)}` },
          {
            label: "Minutes played",
            value: String(rows.reduce((s, r) => s + (r.validMinutes ?? 0), 0)),
          },
        ],
        rows: rows.map((r) => ({
          sessionId: String(r._id),
          playerId: String(r.playerId),
          pcId: String(r.pcId),
          game: r.game ?? "",
          status: r.status,
          paymentSource: r.paymentSource ?? "",
          mode: r.sessionMode ?? "",
          startTime: iso(r.startTime),
          endTime: iso(r.endTime),
          validMinutes: r.validMinutes ?? 0,
          cost: num(r.cost),
          xpAwarded: r.xpAwarded ?? 0,
        })),
      };
    }

    case "revenue": {
      const match: Record<string, unknown> = { zoneId: zid };
      if (hasRange) match.createdAt = range;
      const rows = await WalletLedger.find(match).sort({ createdAt: -1 }).limit(20_000).lean();
      const credits = rows.filter((r) => num(r.amount) > 0).reduce((s, r) => s + num(r.amount), 0);
      const debits = rows.filter((r) => num(r.amount) < 0).reduce((s, r) => s + num(r.amount), 0);
      return {
        title: "Wallet ledger",
        columns: [
          { key: "entryId", label: "Entry ID" },
          { key: "createdAt", label: "When" },
          { key: "playerId", label: "Player ID" },
          { key: "type", label: "Type" },
          { key: "method", label: "Method" },
          { key: "amount", label: "Amount", numeric: true },
          { key: "reference", label: "Reference" },
          { key: "createdBy", label: "By" },
        ],
        summary: [
          { label: "Entries", value: String(rows.length) },
          { label: "Credits", value: `₹${credits.toFixed(2)}` },
          { label: "Debits", value: `₹${Math.abs(debits).toFixed(2)}` },
          { label: "Net", value: `₹${(credits + debits).toFixed(2)}` },
        ],
        rows: rows.map((r) => ({
          entryId: String(r._id),
          createdAt: iso(r.createdAt),
          playerId: String(r.playerId),
          type: r.type,
          method: r.method,
          amount: num(r.amount),
          reference: r.reference ?? "",
          createdBy: r.createdBy,
        })),
      };
    }

    case "players": {
      const stats = await playerAnalytics(params.zoneId);
      return {
        title: "Players",
        columns: [
          { key: "playerId", label: "Player ID" },
          { key: "displayName", label: "Player" },
          { key: "level", label: "Level", numeric: true },
          { key: "sessions", label: "Sessions", numeric: true },
          { key: "minutes", label: "Minutes", numeric: true },
          { key: "spend", label: "Spend", numeric: true },
          { key: "firstPlayed", label: "First played" },
          { key: "lastPlayed", label: "Last played" },
        ],
        summary: [
          { label: "Players", value: String(stats.totalPlayers) },
          { label: "Active (30d)", value: String(stats.activeInWindow) },
          { label: "New (30d)", value: String(stats.newPlayers) },
          { label: "Returning", value: `${stats.retentionPct}%` },
        ],
        rows: stats.topPlayers.map((p) => ({
          ...p,
          firstPlayed: iso(p.firstPlayed),
          lastPlayed: iso(p.lastPlayed),
        })),
      };
    }

    case "shop": {
      const match: Record<string, unknown> = { zoneId: zid };
      if (hasRange) match.createdAt = range;
      const [orders, stats] = await Promise.all([
        Order.find(match).sort({ createdAt: -1 }).limit(10_000).lean(),
        shopAnalytics(params.zoneId),
      ]);
      return {
        title: "Shop orders",
        columns: [
          { key: "orderId", label: "Order ID" },
          { key: "createdAt", label: "When" },
          { key: "playerId", label: "Player ID" },
          { key: "pcId", label: "PC ID" },
          { key: "items", label: "Items" },
          { key: "total", label: "Total", numeric: true },
          { key: "paymentSource", label: "Payment" },
          { key: "status", label: "Status" },
        ],
        summary: [
          { label: "Orders", value: String(orders.length) },
          { label: "Revenue (30d)", value: `₹${stats.revenue.toFixed(2)}` },
          { label: "Best seller", value: stats.bestSellers[0]?.name ?? "—" },
          { label: "Low stock items", value: String(stats.lowStock.length) },
        ],
        rows: orders.map((o) => ({
          orderId: String(o._id),
          createdAt: iso(o.createdAt),
          playerId: String(o.playerId),
          pcId: o.pcId ? String(o.pcId) : "",
          items: (o.items ?? [])
            .map((i: { name?: string | null; qty?: number | null }) => `${i.name ?? "?"} x${i.qty ?? 0}`)
            .join("; "),
          total: num(o.total),
          paymentSource: o.paymentSource,
          status: o.status,
        })),
      };
    }

    case "bookings": {
      const match: Record<string, unknown> = { zoneId: zid };
      if (hasRange) match.slotStart = range;
      const rows = await Booking.find(match).sort({ slotStart: -1 }).limit(10_000).lean();
      const paid = rows.filter((r) => r.paymentStatus === "paid");
      return {
        title: "Bookings",
        columns: [
          { key: "bookingId", label: "Booking ID" },
          { key: "playerId", label: "Player ID" },
          { key: "pcId", label: "PC ID" },
          { key: "slotStart", label: "Slot start" },
          { key: "slotEnd", label: "Slot end" },
          { key: "amount", label: "Amount", numeric: true },
          { key: "paymentStatus", label: "Payment" },
          { key: "status", label: "Status" },
        ],
        summary: [
          { label: "Bookings", value: String(rows.length) },
          { label: "Paid", value: String(paid.length) },
          { label: "Value", value: `₹${paid.reduce((s, r) => s + num(r.amount), 0).toFixed(2)}` },
          {
            label: "Cancelled",
            value: String(rows.filter((r) => r.status === "cancelled").length),
          },
        ],
        rows: rows.map((r) => ({
          bookingId: String(r._id),
          playerId: String(r.playerId),
          pcId: String(r.pcId),
          slotStart: iso(r.slotStart),
          slotEnd: iso(r.slotEnd),
          amount: num(r.amount),
          paymentStatus: r.paymentStatus,
          status: r.status,
        })),
      };
    }

    case "events": {
      const stats = await eventAnalytics(params.zoneId);
      return {
        title: "Events",
        columns: [
          { key: "tournamentId", label: "Event ID" },
          { key: "name", label: "Name" },
          { key: "game", label: "Game" },
          { key: "status", label: "Status" },
          { key: "crossZone", label: "Cross-zone" },
          { key: "isHost", label: "Host" },
          { key: "registrations", label: "Registered", numeric: true },
          { key: "registrationsFromThisZone", label: "From this zone", numeric: true },
          { key: "checkedIn", label: "Checked in", numeric: true },
          { key: "revenueThisZone", label: "Revenue (this zone)", numeric: true },
          { key: "verificationStatus", label: "Verification" },
        ],
        summary: [
          { label: "Events", value: String(stats.totalEvents) },
          { label: "Cross-zone", value: String(stats.crossZoneEvents) },
          { label: "Registrations", value: String(stats.totalRegistrations) },
          { label: "Revenue (this zone)", value: `₹${stats.revenueThisZone.toFixed(2)}` },
        ],
        rows: stats.events.map((e) => ({
          ...e,
          crossZone: e.crossZone ? "yes" : "no",
          isHost: e.isHost ? "yes" : "no",
        })),
      };
    }

    default:
      throw badRequest(`Unknown export type ${params.type}`);
  }
}

// ─── Renderers ───────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  // A leading =, +, - or @ is executed as a formula by Excel and Sheets, so a
  // player-supplied name could run on the owner's machine. Prefix breaks it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function renderCsv(data: Dataset): string {
  const header = data.columns.map((c) => csvEscape(c.label)).join(",");
  const lines = data.rows.map((row) =>
    data.columns.map((c) => csvEscape(row[c.key])).join(",")
  );
  return [header, ...lines].join("\n");
}

export async function renderXlsx(data: Dataset, meta: { zoneName: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SEIKA Gaming Zone OS";
  wb.created = new Date();

  const sheet = wb.addWorksheet(data.title.slice(0, 31));

  sheet.addRow([`${meta.zoneName} — ${data.title}`]);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow([`Generated ${new Date().toISOString()}`]);
  sheet.addRow([]);

  if (data.summary?.length) {
    for (const item of data.summary) sheet.addRow([item.label, item.value]);
    sheet.addRow([]);
  }

  const headerRow = sheet.addRow(data.columns.map((c) => c.label));
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  });

  for (const row of data.rows) {
    sheet.addRow(
      data.columns.map((c) => {
        const v = row[c.key];
        return c.numeric ? Number(v ?? 0) : (v ?? "");
      })
    );
  }

  data.columns.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = Math.min(40, Math.max(12, c.label.length + 4));
    if (c.numeric) col.numFmt = "#,##0.00";
  });
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function renderPdf(data: Dataset, meta: { zoneName: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Landscape: these tables are wide, and a report nobody can read is not a
    // report.
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fontSize(16).font("Helvetica-Bold").text(`${meta.zoneName} — ${data.title}`);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#666")
      .text(`Generated ${new Date().toISOString()} · ${data.rows.length} rows`);
    doc.fillColor("#000").moveDown(0.6);

    if (data.summary?.length) {
      doc.fontSize(10).font("Helvetica-Bold");
      doc.text(data.summary.map((s) => `${s.label}: ${s.value}`).join("    "));
      doc.moveDown(0.6);
    }

    // Columns are sized by their share of total label+content weight, so an id
    // column does not squeeze a name column into unreadability.
    const weights = data.columns.map((c) => Math.max(c.label.length, c.numeric ? 8 : 14));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / totalWeight) * pageWidth);

    const drawHeader = () => {
      const y = doc.y;
      doc.fontSize(8).font("Helvetica-Bold");
      let x = doc.page.margins.left;
      data.columns.forEach((c, i) => {
        doc.text(c.label, x + 2, y, { width: widths[i] - 4, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(doc.page.margins.left, y + 12).lineTo(doc.page.margins.left + pageWidth, y + 12).stroke();
      doc.y = y + 16;
    };

    drawHeader();
    doc.fontSize(7.5).font("Helvetica");

    for (const row of data.rows) {
      // Leave room for the footer line.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 24) {
        doc.addPage();
        doc.fontSize(8).font("Helvetica-Bold");
        drawHeader();
        doc.fontSize(7.5).font("Helvetica");
      }
      const y = doc.y;
      let x = doc.page.margins.left;
      data.columns.forEach((c, i) => {
        const v = row[c.key];
        const text = c.numeric ? Number(v ?? 0).toFixed(2) : String(v ?? "");
        doc.text(text, x + 2, y, {
          width: widths[i] - 4,
          height: 10,
          ellipsis: true,
          lineBreak: false,
          align: c.numeric ? "right" : "left",
        });
        x += widths[i];
      });
      doc.y = y + 11;
    }

    if (!data.rows.length) {
      doc.moveDown().fontSize(10).fillColor("#666").text("No rows for the selected range.");
    }

    doc.end();
  });
}

/** Renders a dataset in the requested format, with the right HTTP metadata. */
export async function renderExport(params: {
  type: ExportType;
  format: ExportFormat;
  zoneId: string;
  since?: Date;
  until?: Date;
}): Promise<{ body: string | Buffer; contentType: string; filename: string; rows: number }> {
  const zone = await Zone.findById(params.zoneId).select("name").lean();
  const zoneName = (zone?.name as string) ?? "SEIKA zone";
  const data = await buildDataset(params);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `seika-${params.type}-${stamp}`;

  switch (params.format) {
    case "csv":
      return {
        body: renderCsv(data),
        contentType: "text/csv; charset=utf-8",
        filename: `${base}.csv`,
        rows: data.rows.length,
      };
    case "xlsx":
      return {
        body: await renderXlsx(data, { zoneName }),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `${base}.xlsx`,
        rows: data.rows.length,
      };
    case "pdf":
      return {
        body: await renderPdf(data, { zoneName }),
        contentType: "application/pdf",
        filename: `${base}.pdf`,
        rows: data.rows.length,
      };
    default:
      throw badRequest(`Unknown format ${params.format}`);
  }
}
