import mongoose from "mongoose";

import { MigrationImport } from "../../models/MigrationImport.js";
import { Player } from "../../models/Player.js";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry } from "../wallet/wallet.service.js";
import { regionForCountry } from "../leaderboard/leaderboard.service.js";

/** SEIKA fields an import can populate. `name` plus one contact are required. */
export const MAPPABLE_FIELDS = [
  "name",
  "phone",
  "email",
  "gamerTag",
  "city",
  "country",
  "openingBalance",
  "membership",
  "playedHours",
  "sessionsCount",
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

export type Mapping = Partial<Record<MappableField, string>>;

export interface RowIssue {
  row: number; // 1-based, matching what the owner sees in their spreadsheet
  field?: string;
  message: string;
}

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  issues: RowIssue[];
  /** First few mapped rows, so the owner can eyeball the mapping. */
  preview: Record<string, unknown>[];
}

/**
 * Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes,
 * embedded commas and newlines, and both CRLF and LF. Deliberately dependency
 * free — an import file is untrusted input and this is the whole contract.
 */
export function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const stripped = text.replace(/^﻿/, ""); // drop a UTF-8 BOM from Excel
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inQuotes) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && stripped[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  // Trailing field / record with no newline at end of file.
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) throw badRequest("The file has no rows");

  const columns = nonEmpty[0].map((c) => c.trim());
  if (new Set(columns).size !== columns.length) {
    throw badRequest("The header row has duplicate column names");
  }

  const rows = nonEmpty.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = (cells[idx] ?? "").trim();
    });
    return row;
  });

  return { columns, rows };
}

/** Guesses a mapping from common column names, so the wizard opens pre-filled. */
export function guessMapping(columns: string[]): Mapping {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates: Record<MappableField, string[]> = {
    name: ["name", "fullname", "customername", "playername"],
    phone: ["phone", "mobile", "mobileno", "phonenumber", "contact"],
    email: ["email", "emailaddress", "mail"],
    gamerTag: ["gamertag", "nickname", "username", "handle", "alias"],
    city: ["city", "town"],
    country: ["country"],
    openingBalance: ["balance", "walletbalance", "openingbalance", "credit", "currentbalance"],
    membership: ["membership", "membershiptype", "tier", "plan"],
    playedHours: ["playedhours", "hours", "totalhours", "hoursplayed"],
    sessionsCount: ["sessions", "sessioncount", "totalsessions", "visits"],
  };

  const mapping: Mapping = {};
  for (const field of MAPPABLE_FIELDS) {
    const match = columns.find((c) => candidates[field].includes(norm(c)));
    if (match) mapping[field] = match;
  }
  return mapping;
}

function normalizePhone(v: string): string {
  const digits = v.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export interface MappedRow {
  row: number;
  name: string;
  phone?: string;
  email?: string;
  gamerTag?: string;
  city?: string;
  country?: string;
  openingBalance: number;
  membership?: string;
  playedHours?: number;
  sessionsCount?: number;
}

/**
 * Applies a mapping and validates every row. Invalid rows are reported but do
 * not stop the run — the plan (N3) wants bad rows flagged while the good ones
 * are still previewable.
 */
export async function validateRows(params: {
  rows: Record<string, string>[];
  mapping: Mapping;
}): Promise<{ report: ValidationReport; valid: MappedRow[] }> {
  const { rows, mapping } = params;
  if (!mapping.name) throw badRequest("Map the `name` field before validating");
  if (!mapping.phone && !mapping.email) {
    throw badRequest("Map at least one of `phone` or `email` — a player needs a way to log in");
  }

  const issues: RowIssue[] = [];
  const valid: MappedRow[] = [];
  const seenPhone = new Set<string>();
  const seenEmail = new Set<string>();
  let duplicateRows = 0;

  // Contacts that already belong to a SEIKA player are duplicates too.
  const existing = await Player.find({}, { phone: 1, email: 1 }).lean();
  for (const p of existing) {
    if (p.phone) seenPhone.add(String(p.phone));
    if (p.email) seenEmail.add(String(p.email).toLowerCase());
  }

  rows.forEach((raw, idx) => {
    const rowNo = idx + 2; // +1 for the header, +1 for 1-based counting
    const pick = (field: MappableField) => (mapping[field] ? raw[mapping[field]!] ?? "" : "");

    const name = pick("name").trim();
    const phone = mapping.phone ? normalizePhone(pick("phone")) : "";
    const email = pick("email").trim().toLowerCase();
    const balanceRaw = pick("openingBalance").replace(/[₹,\s]/g, "");

    let rowOk = true;
    if (!name) {
      issues.push({ row: rowNo, field: "name", message: "Name is empty" });
      rowOk = false;
    }
    if (!phone && !email) {
      issues.push({ row: rowNo, message: "Row has neither a phone nor an email" });
      rowOk = false;
    }
    if (phone && phone.length !== 10) {
      issues.push({ row: rowNo, field: "phone", message: `"${pick("phone")}" is not a 10-digit mobile` });
      rowOk = false;
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      issues.push({ row: rowNo, field: "email", message: `"${email}" is not a valid email` });
      rowOk = false;
    }

    let openingBalance = 0;
    if (balanceRaw) {
      const parsed = Number(balanceRaw);
      if (!Number.isFinite(parsed)) {
        issues.push({ row: rowNo, field: "openingBalance", message: `"${balanceRaw}" is not a number` });
        rowOk = false;
      } else if (parsed < 0) {
        issues.push({
          row: rowNo,
          field: "openingBalance",
          message: "Negative opening balances are not imported — settle dues in the old system first",
        });
        rowOk = false;
      } else {
        openingBalance = +parsed.toFixed(2);
      }
    }

    if (rowOk) {
      if (phone && seenPhone.has(phone)) {
        issues.push({ row: rowNo, field: "phone", message: `Duplicate phone ${phone}` });
        duplicateRows++;
        return;
      }
      if (email && seenEmail.has(email)) {
        issues.push({ row: rowNo, field: "email", message: `Duplicate email ${email}` });
        duplicateRows++;
        return;
      }
      if (phone) seenPhone.add(phone);
      if (email) seenEmail.add(email);

      const num = (field: MappableField) => {
        const v = Number(pick(field).replace(/[,\s]/g, ""));
        return Number.isFinite(v) ? v : undefined;
      };
      valid.push({
        row: rowNo,
        name,
        phone: phone || undefined,
        email: email || undefined,
        gamerTag: pick("gamerTag") || undefined,
        city: pick("city") || undefined,
        country: pick("country") || undefined,
        openingBalance,
        membership: pick("membership") || undefined,
        playedHours: mapping.playedHours ? num("playedHours") : undefined,
        sessionsCount: mapping.sessionsCount ? num("sessionsCount") : undefined,
      });
    }
  });

  const report: ValidationReport = {
    totalRows: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length - duplicateRows,
    duplicateRows,
    issues,
    preview: valid.slice(0, 10) as unknown as Record<string, unknown>[],
  };

  return { report, valid };
}

/**
 * Commits an import. Everything — every player and every opening-balance ledger
 * entry — goes in one transaction, so a failure part-way leaves no half-imported
 * zone behind (plan N6).
 *
 * Imported players are created unverified: the first OTP login proves the person
 * actually owns that number before they can spend the carried-over balance
 * (plan N5).
 */
export async function commitImport(params: {
  importId: string;
  zoneId: string;
  actorId: string;
  /**
   * Test seam (plan N6 / D7): called after each player is written so a suite
   * can fail the run part-way and prove the transaction rolls back. Never set
   * by any route.
   */
  onRowWritten?: (index: number) => void | Promise<void>;
}) {
  const run = await MigrationImport.findById(params.importId);
  if (!run) throw notFound("Import not found");
  if (String(run.zoneId) !== params.zoneId) throw notFound("Import not found");
  if (run.status === "committed") throw badRequest("This import has already been committed");
  if (run.status !== "mapped") throw badRequest("Set and validate a column mapping first");

  // Re-validate at commit time: the world may have moved since the owner
  // approved the preview (someone signed up with one of these numbers). If the
  // set of importable rows has changed we refuse rather than quietly importing
  // a subset of what was approved — a silently short import is how a zone ends
  // up with a customer who "was migrated" but cannot log in.
  const { report: fresh, valid } = await validateRows({
    rows: run.rows as Record<string, string>[],
    mapping: run.mapping as Mapping,
  });
  if (!valid.length) throw badRequest("No valid rows to import");

  const approved = (run.report as ValidationReport | undefined)?.validRows;
  if (approved !== undefined && approved !== fresh.validRows) {
    run.report = fresh;
    await run.save();
    throw conflict(
      `The file no longer matches what was validated: ${approved} rows were approved, ` +
        `${fresh.validRows} are importable now. Review the report and validate again.`
    );
  }

  try {
    const result = await withTransaction(async (txn) => {
      const createdPlayerIds: string[] = [];
      let balanceRows = 0;
      let balanceTotal = 0;

      for (const row of valid) {
        const [player] = await Player.create(
          [
            {
              name: row.name,
              username: `imported_${new mongoose.Types.ObjectId().toString().slice(-10)}`,
              phone: row.phone,
              email: row.email,
              gamerTag: row.gamerTag,
              city: row.city,
              country: row.country,
              region: regionForCountry(row.country),
              // Unverified until the player completes an OTP login (plan N5).
              otpVerified: false,
              importedFrom: run.filename ?? "migration",
              importedAt: new Date(),
              legacy: {
                membership: row.membership,
                playedHours: row.playedHours,
                sessionsCount: row.sessionsCount,
              },
            },
          ],
          { session: txn }
        );
        createdPlayerIds.push(String(player._id));
        if (params.onRowWritten) await params.onRowWritten(createdPlayerIds.length - 1);

        if (row.openingBalance > 0) {
          // The carried-over balance is a ledger entry, never a stored balance —
          // the same invariant every other rupee in SEIKA obeys (plan N4).
          await addWalletEntry(
            {
              playerId: String(player._id),
              zoneId: params.zoneId,
              amount: row.openingBalance,
              type: "OPENING_BALANCE",
              method: "CASH",
              reference: `migration:${params.importId}:row${row.row}`,
              createdBy: params.actorId,
            },
            txn
          );
          balanceRows++;
          balanceTotal = +(balanceTotal + row.openingBalance).toFixed(2);
        }
      }

      run.status = "committed";
      run.result = {
        playersCreated: createdPlayerIds.length,
        openingBalanceEntries: balanceRows,
        openingBalanceTotal: balanceTotal,
        playerIds: createdPlayerIds,
      };
      await run.save({ session: txn });

      return run.result as Record<string, unknown>;
    });

    return result;
  } catch (err) {
    // The transaction rolled back; record why so the owner can fix the file.
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    await run.save();
    throw err;
  }
}
