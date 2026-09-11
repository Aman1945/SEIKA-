import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { MigrationImport } from "../../models/MigrationImport.js";
import { audit } from "../audit/audit.service.js";
import {
  MAPPABLE_FIELDS,
  commitImport,
  guessMapping,
  parseCsv,
  validateRows,
  type Mapping,
} from "./migration.service.js";

export const migrationRouter = Router();
migrationRouter.use(requireAuth);
// Importing players and their carried-over money is an owner-level action.
migrationRouter.use(requireRole("SUPER_ADMIN", "ZONE_OWNER"));

/** Upload step: parse the file, return the columns and a guessed mapping. */
migrationRouter.post(
  "/uploads",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        filename: z.string().max(200).optional(),
        // The CSV itself, as text. Kept small enough to stay in one request;
        // larger migrations should be split per file by the wizard.
        csv: z.string().min(1).max(5_000_000),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");

    const { columns, rows } = parseCsv(body.data.csv);
    const mapping = guessMapping(columns);

    const run = await MigrationImport.create({
      zoneId: req.tenantZoneId,
      createdBy: req.auth!.sub,
      filename: body.data.filename,
      status: "uploaded",
      sourceColumns: columns,
      mapping,
      rows,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: req.tenantZoneId,
      action: "MIGRATION_UPLOAD",
      entityType: "migration",
      entityId: String(run._id),
      newValue: { filename: body.data.filename, rows: rows.length },
    });

    res.status(201).json({
      ok: true,
      importId: String(run._id),
      columns,
      mappableFields: MAPPABLE_FIELDS,
      suggestedMapping: mapping,
      rowCount: rows.length,
      // A first look at the raw file, before any mapping is applied.
      sample: rows.slice(0, 5),
    });
  })
);

/** Mapping step: set the column mapping and get the validation report back. */
migrationRouter.post(
  "/:id/mapping",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        mapping: z.record(z.string(), z.string()),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const run = await MigrationImport.findOne({
      _id: req.params.id,
      zoneId: req.tenantZoneId,
    });
    if (!run) throw notFound("Import not found");
    if (run.status === "committed") throw badRequest("This import has already been committed");

    const unknownField = Object.keys(body.data.mapping).find(
      (k) => !(MAPPABLE_FIELDS as readonly string[]).includes(k)
    );
    if (unknownField) throw badRequest(`Unknown field "${unknownField}"`);

    const unknownColumn = Object.values(body.data.mapping).find(
      (c) => !(run.sourceColumns as string[]).includes(c)
    );
    if (unknownColumn) throw badRequest(`Column "${unknownColumn}" is not in the file`);

    const mapping = body.data.mapping as Mapping;
    const { report } = await validateRows({
      rows: run.rows as Record<string, string>[],
      mapping,
    });

    run.mapping = mapping;
    run.report = report;
    run.status = "mapped";
    await run.save();

    res.json({ ok: true, importId: String(run._id), status: run.status, report });
  })
);

/** Commit step: write the players and their opening balances, all or nothing. */
migrationRouter.post(
  "/:id/commit",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const result = await commitImport({
      importId: req.params.id,
      zoneId: req.tenantZoneId,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: req.tenantZoneId,
      action: "MIGRATION_COMMIT",
      entityType: "migration",
      entityId: req.params.id,
      newValue: result,
    });

    res.json({ ok: true, importId: req.params.id, ...result });
  })
);

/** Status / report for one import run. */
migrationRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const run = await MigrationImport.findOne({
      _id: req.params.id,
      zoneId: req.tenantZoneId,
    })
      .select("-rows") // the raw rows are large and not useful here
      .lean();
    if (!run) throw notFound("Import not found");
    res.json({ ok: true, import: run });
  })
);

/** All import runs for this zone. */
migrationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const runs = await MigrationImport.find({ zoneId: req.tenantZoneId })
      .select("-rows -report")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ ok: true, imports: runs });
  })
);
