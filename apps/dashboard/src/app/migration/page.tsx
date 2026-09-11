"use client";

import { useState } from "react";

import type { MigrationUpload, ValidationReport } from "@seika/types";

import { useSession } from "@/lib/session";
import { ErrorNote, money } from "@/components/ui";

/**
 * The migration wizard (plan module N): upload → map → review → import.
 *
 * The review step is the point of the whole screen. Importing players carries
 * their old wallet balances over as real money, so the owner sees exactly what
 * will land — and exactly which rows will not — before anything is written.
 */
type Step = "upload" | "map" | "done";

export default function MigrationPage() {
  const { api } = useSession();

  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<MigrationUpload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [result, setResult] = useState<{
    playersCreated: number;
    openingBalanceEntries: number;
    openingBalanceTotal: number;
  } | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const csv = await file.text();
      const res = await api.migration.upload(csv, file.name);
      setUpload(res);
      // The API guesses a mapping from the header names, so the wizard opens
      // pre-filled rather than asking the owner to match ten columns by hand.
      setMapping(res.suggestedMapping);
      setStep("map");
      setReport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      const cleaned = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
      const res = await api.migration.setMapping(upload.importId, cleaned);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!upload || !report) return;
    if (
      !window.confirm(
        `Import ${report.validRows} players? Their carried-over balances become real wallet money.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.migration.commit(upload.importId);
      setResult(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Import players</h1>
      <p className="page-sub">
        Bring players over from your previous software. Balances arrive as ledger entries, and every
        imported player verifies their number by OTP before they can spend it.
      </p>

      <ErrorNote error={error} />

      {step === "upload" && (
        <div className="card">
          <div className="card__head">
            <h2 className="card__title">1 · Upload the export</h2>
          </div>
          <p className="small faint" style={{ marginTop: 0 }}>
            A CSV from Senet or a similar tool. Nothing is written until you review what it contains.
          </p>
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} />
        </div>
      )}

      {step === "map" && upload && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card__head">
              <h2 className="card__title">2 · Match the columns</h2>
              <div className="card__actions">
                <span className="small faint">{upload.rowCount} rows</span>
              </div>
            </div>

            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              {upload.mappableFields.map((field) => (
                <div className="field" key={field}>
                  <label htmlFor={`map-${field}`}>
                    {field}
                    {(field === "name" || field === "phone") && (
                      <span style={{ color: "var(--warn)" }}> ·  needed</span>
                    )}
                  </label>
                  <select
                    id={`map-${field}`}
                    value={mapping[field] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                  >
                    <option value="">— not in this file —</option>
                    {upload.columns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <button className="btn--primary" disabled={busy} onClick={() => void validate()}>
              {busy ? "Checking…" : "Check the file"}
            </button>
          </div>

          {report && (
            <div className="card">
              <div className="card__head">
                <h2 className="card__title">3 · Review</h2>
              </div>

              <div className="grid" style={{ marginBottom: 12 }}>
                <div className="stat">
                  <div className="stat__label">Will import</div>
                  <div className="stat__value" style={{ color: "var(--ok)" }}>
                    {report.validRows}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat__label">Skipped</div>
                  <div className="stat__value" style={{ color: report.invalidRows ? "var(--warn)" : undefined }}>
                    {report.invalidRows}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat__label">Duplicates</div>
                  <div className="stat__value">{report.duplicateRows}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">Total rows</div>
                  <div className="stat__value">{report.totalRows}</div>
                </div>
              </div>

              {report.issues.length > 0 && (
                <>
                  <h3 className="card__title" style={{ marginBottom: 8 }}>
                    Rows that need attention
                  </h3>
                  <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Row</th>
                          <th>Field</th>
                          <th>Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.issues.slice(0, 50).map((issue, i) => (
                          <tr key={i}>
                            {/* The row number is the one they see in Excel. */}
                            <td className="num">{issue.row}</td>
                            <td className="small faint">{issue.field ?? "—"}</td>
                            <td className="small">{issue.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="small faint">
                    Fix them in the file and upload again, or import the {report.validRows} valid rows
                    now and bring the rest across later.
                  </p>
                </>
              )}

              {report.preview.length > 0 && (
                <>
                  <h3 className="card__title" style={{ margin: "16px 0 8px" }}>
                    First few players
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Phone</th>
                          <th className="right">Opening balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.preview.map((row, i) => (
                          <tr key={i}>
                            <td>{String(row.name ?? "")}</td>
                            <td className="mono small">{String(row.phone ?? row.email ?? "")}</td>
                            <td className="right num">{money(Number(row.openingBalance ?? 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="btn-row" style={{ marginTop: 14 }}>
                <button
                  className="btn--primary"
                  disabled={busy || report.validRows === 0}
                  onClick={() => void commit()}
                >
                  Import {report.validRows} players
                </button>
                <button disabled={busy} onClick={() => setStep("upload")}>
                  Start over
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {step === "done" && result && (
        <div className="card">
          <div className="alert alert--ok">Import complete.</div>
          <div className="grid">
            <div className="stat">
              <div className="stat__label">Players created</div>
              <div className="stat__value">{result.playersCreated}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Balances carried over</div>
              <div className="stat__value">{result.openingBalanceEntries}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Total carried</div>
              <div className="stat__value">{money(result.openingBalanceTotal)}</div>
            </div>
          </div>
          <p className="small faint">
            Each imported player is inactive until their first OTP login proves they own the number.
            Their balance is waiting for them.
          </p>
          <button
            onClick={() => {
              setStep("upload");
              setUpload(null);
              setReport(null);
              setResult(null);
            }}
          >
            Import another file
          </button>
        </div>
      )}
    </>
  );
}
