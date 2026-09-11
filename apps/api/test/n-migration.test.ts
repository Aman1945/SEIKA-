import { describe, it, expect } from "vitest";

import { as, seedPlayer, seedStaff, seedZone } from "./helpers/factories.js";
import { Player } from "../src/models/Player.js";
import { WalletLedger } from "../src/models/WalletLedger.js";
import { MigrationImport } from "../src/models/MigrationImport.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";
import { parseCsv } from "../src/modules/migration/migration.service.js";

const CLEAN_CSV = [
  "Customer Name,Mobile No,Email,Wallet Balance,Membership,Total Hours,Sessions",
  "Arjun Mehta,9812345601,arjun@example.com,450.50,Gold,120,48",
  "Priya Nair,9812345602,priya@example.com,0,Silver,30,12",
  "Rohit Sharma,+919812345603,,275,Bronze,12,5",
].join("\n");

/**
 * Module N — data migration from a previous system (plan §7.N).
 * N4 (opening balance must be a ledger entry) and N6 (no partial import) are P0.
 */
describe("N. Data migration", () => {
  it("N1 — uploading a CSV returns the columns and a preview", async () => {
    const zone = await seedZone();

    const res = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ filename: "senet-players.csv", csv: CLEAN_CSV });

    expect(res.status).toBe(201);
    expect(res.body.rowCount).toBe(3);
    expect(res.body.columns).toContain("Wallet Balance");
    expect(res.body.sample).toHaveLength(3);
    expect(res.body.importId).toBeTruthy();
  });

  it("N2 — old column names are mapped onto SEIKA fields", async () => {
    const zone = await seedZone();

    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });

    // The wizard opens pre-filled from the header names.
    expect(upload.body.suggestedMapping).toMatchObject({
      name: "Customer Name",
      phone: "Mobile No",
      email: "Email",
      openingBalance: "Wallet Balance",
      membership: "Membership",
      playedHours: "Total Hours",
      sessionsCount: "Sessions",
    });

    const mapped = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });

    expect(mapped.status).toBe(200);
    expect(mapped.body.report.validRows).toBe(3);
    expect(mapped.body.report.preview[0]).toMatchObject({
      name: "Arjun Mehta",
      phone: "9812345601",
      openingBalance: 450.5,
    });
    // +91 prefixes are normalized to a bare 10-digit mobile.
    expect(mapped.body.report.preview[2].phone).toBe("9812345603");
  });

  it("N3 — invalid and duplicate rows are flagged while valid rows still preview", async () => {
    const zone = await seedZone();
    // An existing SEIKA player, so their number is already taken.
    const existing = await seedPlayer({ zoneId: zone.zoneId });
    const existingPhone = existing.phone;

    const messy = [
      "Customer Name,Mobile No,Wallet Balance",
      "Good Row,9812345610,100",
      ",9812345611,50", // no name
      "No Contact,,75", // no phone
      "Bad Phone,12345,20", // not 10 digits
      "Bad Money,9812345612,abc", // balance is not a number
      "Negative,9812345613,-40", // negative carried balance
      "Dupe In File,9812345610,10", // duplicate of row 2
      `Already Here,${existingPhone},60`, // duplicate of a SEIKA player
    ].join("\n");

    const upload = await as(zone.ownerToken).post("/api/migration/uploads").send({ csv: messy });
    const mapped = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({
        mapping: {
          name: "Customer Name",
          phone: "Mobile No",
          openingBalance: "Wallet Balance",
        },
      });

    const report = mapped.body.report;
    expect(report.totalRows).toBe(8);
    expect(report.validRows).toBe(1); // only "Good Row"
    expect(report.duplicateRows).toBe(2);
    expect(report.invalidRows).toBe(5);
    expect(report.preview[0].name).toBe("Good Row");

    // Each problem names the row the owner sees in their spreadsheet.
    const rows = report.issues.map((i: { row: number }) => i.row);
    expect(rows).toContain(3); // missing name
    expect(report.issues.some((i: { message: string }) => /not a number/.test(i.message))).toBe(true);
    expect(report.issues.some((i: { message: string }) => /Negative/i.test(i.message))).toBe(true);
    expect(report.issues.some((i: { message: string }) => /Duplicate/i.test(i.message))).toBe(true);
  });

  it("N4 — an imported opening balance becomes a ledger entry, not a stored balance", async () => {
    const zone = await seedZone();

    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ filename: "senet.csv", csv: CLEAN_CSV });
    await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });

    const commit = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.playersCreated).toBe(3);
    // Two of the three rows carried a non-zero balance.
    expect(commit.body.openingBalanceEntries).toBe(2);
    expect(commit.body.openingBalanceTotal).toBe(725.5);

    const arjun = await Player.findOne({ phone: "9812345601" }).lean();
    expect(arjun).toBeTruthy();

    // The balance is derived from the ledger, exactly like every other rupee.
    expect(await getWalletBalance(String(arjun!._id))).toBe(450.5);

    const rows = await WalletLedger.find({ playerId: arjun!._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("OPENING_BALANCE");
    expect(String(rows[0].reference)).toContain("migration:");

    // A zero-balance player gets no ledger row at all.
    const priya = await Player.findOne({ phone: "9812345602" }).lean();
    expect(await WalletLedger.countDocuments({ playerId: priya!._id })).toBe(0);
  });

  it("N5 — an imported player is unverified until their first OTP login", async () => {
    const zone = await seedZone();

    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });
    await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });
    await as(zone.ownerToken).post(`/api/migration/${upload.body.importId}/commit`).send({});

    const before = await Player.findOne({ phone: "9812345601" }).lean();
    expect(before!.otpVerified).toBe(false);
    expect(before!.importedFrom).toBeTruthy();
    expect(before!.legacy?.membership).toBe("Gold");

    // The player logs in for the first time; OTP proves they own the number.
    const reqOtp = await as(zone.ownerToken).post("/api/auth/otp/request").send({
      identifier: "9812345601",
    });
    const verify = await as(zone.ownerToken).post("/api/auth/otp/verify").send({
      identifier: "9812345601",
      code: reqOtp.body.devCode,
    });
    expect(verify.status).toBe(200);

    const after = await Player.findOne({ phone: "9812345601" }).lean();
    expect(after!.otpVerified).toBe(true);
    // Activation attaches them to the same record — no duplicate player.
    expect(String(after!._id)).toBe(String(before!._id));
    expect(await Player.countDocuments({ phone: "9812345601" })).toBe(1);
    // And their carried-over balance is intact.
    expect(await getWalletBalance(String(after!._id))).toBe(450.5);
  });

  it("N6 — a failed commit leaves no partial data behind", async () => {
    const zone = await seedZone();

    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });
    await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });

    // Fail the run after the first player is written, which is exactly the
    // "failure midway" the plan asks about.
    const { commitImport } = await import("../src/modules/migration/migration.service.js");
    await expect(
      commitImport({
        importId: upload.body.importId,
        zoneId: zone.zoneId,
        actorId: zone.ownerId,
        onRowWritten: (index) => {
          if (index === 1) throw new Error("simulated failure midway");
        },
      })
    ).rejects.toThrow(/simulated failure/);

    // Nothing survives — not the row written before the failure, and no
    // opening-balance ledger entry for it either.
    expect(await Player.countDocuments({})).toBe(0);
    expect(await WalletLedger.countDocuments({})).toBe(0);

    const run = await MigrationImport.findById(upload.body.importId).lean();
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("simulated failure");
  });

  it("N6b — a commit is refused if the file no longer matches what was approved", async () => {
    const zone = await seedZone();

    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });
    const mapped = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });
    expect(mapped.body.report.validRows).toBe(3);

    // Someone signs up with one of the file's numbers after the owner approved
    // the preview. Importing 2 of 3 silently would leave a "migrated" customer
    // who cannot log in, so the commit must stop and ask for a re-check.
    await Player.create({
      name: "Walk-in",
      username: "walkin_1",
      phone: "9812345602",
      otpVerified: true,
    });

    const commit = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/commit`)
      .send({});
    expect(commit.status).toBe(409);

    // Nothing was imported, and the stored report now shows the new reality.
    expect(await Player.countDocuments({})).toBe(1);
    const run = await MigrationImport.findById(upload.body.importId).lean();
    expect(run!.report.validRows).toBe(2);
    expect(run!.report.duplicateRows).toBe(1);

    // Re-validating, then committing, imports the 2 rows that remain valid.
    await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });
    const retry = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/commit`)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.playersCreated).toBe(2);
  });

  it("N — an import cannot be committed twice", async () => {
    const zone = await seedZone();
    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });
    await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: upload.body.suggestedMapping });

    expect((await as(zone.ownerToken).post(`/api/migration/${upload.body.importId}/commit`).send({})).status).toBe(200);
    const again = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/commit`)
      .send({});
    expect(again.status).toBe(400);
    expect(await Player.countDocuments({ phone: "9812345601" })).toBe(1);
  });

  it("N — committing without a validated mapping is refused", async () => {
    const zone = await seedZone();
    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });

    const res = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/commit`)
      .send({});
    expect(res.status).toBe(400);
    expect(await Player.countDocuments({})).toBe(0);
  });

  it("N — a mapping without name, or without any contact field, is refused", async () => {
    const zone = await seedZone();
    const upload = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });

    const noName = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: { phone: "Mobile No" } });
    expect(noName.status).toBe(400);

    const noContact = await as(zone.ownerToken)
      .post(`/api/migration/${upload.body.importId}/mapping`)
      .send({ mapping: { name: "Customer Name" } });
    expect(noContact.status).toBe(400);
  });

  it("N — a cashier cannot run a migration, and another zone cannot see it", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    const cashier = await seedStaff(zoneA, "CASHIER");

    const denied = await as(cashier.token).post("/api/migration/uploads").send({ csv: CLEAN_CSV });
    expect(denied.status).toBe(403);

    const upload = await as(zoneA.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: CLEAN_CSV });

    // Owner B holds a valid owner token, but for a different tenant.
    expect((await as(zoneB.ownerToken).get(`/api/migration/${upload.body.importId}`)).status).toBe(404);
    expect(
      (await as(zoneB.ownerToken).post(`/api/migration/${upload.body.importId}/commit`).send({})).status
    ).toBe(404);
    expect((await as(zoneB.ownerToken).get("/api/migration")).body.imports).toHaveLength(0);
  });

  it("N — the CSV parser handles quoted fields, commas, newlines and a BOM", () => {
    const csv =
      '﻿Name,Notes,Balance\r\n' +
      '"Mehta, Arjun","Said ""see you"" on Monday",450\r\n' +
      '"Nair\nPriya",Simple,0\r\n';

    const { columns, rows } = parseCsv(csv);
    expect(columns).toEqual(["Name", "Notes", "Balance"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe("Mehta, Arjun");
    expect(rows[0].Notes).toBe('Said "see you" on Monday');
    expect(rows[1].Name).toBe("Nair\nPriya");
  });

  it("N — a file with duplicate header columns is refused", async () => {
    const zone = await seedZone();
    const res = await as(zone.ownerToken)
      .post("/api/migration/uploads")
      .send({ csv: "Name,Phone,Name\nA,9812345620,B" });
    expect(res.status).toBe(400);
  });
});
