"use client";

import { useState } from "react";

import { usePlayer } from "@/lib/session";
import { ErrorNote } from "@/components/ui";

/** Profile customization (plan A6). The gamer tag is what other players see. */
export default function ProfilePage() {
  const { api, passport, refresh, logout } = usePlayer();

  const [form, setForm] = useState({
    gamerTag: passport?.gamerTag ?? "",
    city: passport?.city ?? "",
    country: passport?.country ?? "",
    games: passport?.favoriteGames.join(", ") ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.players.updateProfile({
        gamerTag: form.gamerTag.trim() || undefined,
        city: form.city.trim() || undefined,
        country: form.country.trim() || undefined,
        favoriteGames: form.games
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)
          .slice(0, 10),
      });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Profile</h1>
      <p className="sub">Your gamer tag is what appears on leaderboards and the PC login screen.</p>

      <ErrorNote error={error} />
      {saved && <div className="alert alert--ok">Saved.</div>}

      <form onSubmit={save} className="card">
        <div className="field">
          <label htmlFor="tag">Gamer tag</label>
          <input
            id="tag"
            value={form.gamerTag}
            onChange={(e) => setForm({ ...form, gamerTag: e.target.value })}
            maxLength={24}
            placeholder="NightOwl"
          />
        </div>
        <div className="field">
          <label htmlFor="city">City</label>
          <input
            id="city"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            placeholder="Pune"
          />
        </div>
        <div className="field">
          <label htmlFor="country">Country</label>
          <input
            id="country"
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
            placeholder="India"
          />
          <p className="small faint" style={{ marginTop: 4, marginBottom: 0 }}>
            Sets which city, country and region leaderboards you appear on.
          </p>
        </div>
        <div className="field">
          <label htmlFor="games">Favourite games</label>
          <input
            id="games"
            value={form.games}
            onChange={(e) => setForm({ ...form, games: e.target.value })}
            placeholder="Valorant, CS2"
          />
          <p className="small faint" style={{ marginTop: 4, marginBottom: 0 }}>
            Comma separated.
          </p>
        </div>
        <button className="btn--primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>

      <button className="btn--ghost" onClick={() => void logout()}>
        Sign out
      </button>
    </>
  );
}
