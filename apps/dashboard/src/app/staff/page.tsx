"use client";

import { useState } from "react";

import { STAFF_ROLES, type StaffRole } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData } from "@/lib/realtime";
import { Empty, ErrorNote, Loading } from "@/components/ui";

/**
 * Staff and roles.
 *
 * Creating staff is owner-only, and nobody can grant themselves a role they do
 * not have — the API enforces both, and the role list here is only what the UI
 * offers.
 */
const ASSIGNABLE: StaffRole[] = STAFF_ROLES.filter(
  (r) => r !== "SUPER_ADMIN" && r !== "ZONE_OWNER"
) as StaffRole[];

const ROLE_SUMMARY: Record<StaffRole, string> = {
  SUPER_ADMIN: "Platform level, across all zones",
  ZONE_OWNER: "Full control of this zone",
  BRANCH_MANAGER: "Daily operations and analytics, not staff or zone settings",
  CASHIER: "Counter: cash top-ups, sessions, order queue, basic refunds",
  TECHNICIAN: "Hardware only: PC status and commands, no money or customer data",
  EVENT_MANAGER: "Tournaments and results; payouts need the owner",
};

export default function StaffPage() {
  const { api } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ name: string; role: StaffRole; phone: string }>({
    name: "",
    role: "CASHIER",
    phone: "",
  });

  const staff = useLiveData(() => api.staff.list(), { revision: 0, fallbackMs: 0 });
  const rows = staff.data ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.staff.create({
        name: form.name.trim(),
        role: form.role,
        phone: form.phone.trim() || undefined,
      });
      setForm({ name: "", role: "CASHIER", phone: "" });
      staff.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Staff</h1>
      <p className="page-sub">
        Staff sign in with a one-time code sent to their own number — there is no shared password.
      </p>

      <ErrorNote error={staff.error} />
      <ErrorNote error={error} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__head">
          <h2 className="card__title">Add a staff member</h2>
        </div>
        <form onSubmit={create}>
          <div className="field">
            <label htmlFor="s-name">Name</label>
            <input
              id="s-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="s-phone">Phone (they log in with this)</label>
            <input
              id="s-phone"
              inputMode="numeric"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="9700000001"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="s-role">Role</label>
            <select
              id="s-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole })}
            >
              {ASSIGNABLE.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <p className="small faint" style={{ marginTop: 4, marginBottom: 0 }}>
              {ROLE_SUMMARY[form.role]}
            </p>
          </div>
          <button className="btn--primary" disabled={busy || !form.name.trim() || !form.phone.trim()}>
            Add staff
          </button>
        </form>
      </div>

      <div className="card card--flush">
        {staff.loading && !staff.data ? (
          <div style={{ padding: 14 }}>
            <Loading rows={3} />
          </div>
        ) : rows.length === 0 ? (
          <Empty>No staff yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Signs in with</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s._id}>
                    <td>{s.name}</td>
                    <td>
                      <span className="badge" data-tone={s.role === "ZONE_OWNER" ? "ok" : "idle"}>
                        {s.role.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="small faint">{s.phone ?? s.email ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
