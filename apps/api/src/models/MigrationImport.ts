import { Schema, model, Types } from "mongoose";

export const MigrationStatus = [
  "uploaded", // file parsed, awaiting column mapping
  "mapped", // mapping set + validated, awaiting commit
  "committed", // rows written
  "failed", // commit rolled back
] as const;
export type MigrationStatus = (typeof MigrationStatus)[number];

/**
 * One import run of players from a previous system (Senet and similar).
 *
 * The parsed rows and the validation report are kept on the run itself so the
 * owner can review a preview, fix the source file, and re-map without
 * re-uploading — and so a committed import stays auditable afterwards.
 */
const migrationImportSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    createdBy: { type: String, required: true },
    filename: String,
    status: { type: String, enum: MigrationStatus, default: "uploaded", index: true },
    /** Column headers exactly as they appeared in the source file. */
    sourceColumns: { type: [String], default: [] },
    /** SEIKA field → source column. */
    mapping: { type: Schema.Types.Mixed, default: {} },
    /** Parsed source rows, untouched, so a re-map does not need a re-upload. */
    rows: { type: [Schema.Types.Mixed], default: [] },
    /** Per-row validation outcome from the last mapping. */
    report: { type: Schema.Types.Mixed, default: {} },
    /** Result of the commit: counts and the ids created. */
    result: { type: Schema.Types.Mixed },
    error: String,
  },
  { timestamps: true }
);

export const MigrationImport = model("MigrationImport", migrationImportSchema);
