"use client";

import { useEffect, useState } from "react";

import type { LeaderboardRow, LeaderboardScope } from "@seika/types";

import { usePlayer } from "@/lib/session";
import { Empty, ErrorNote, Loading } from "@/components/ui";

/**
 * Leaderboards (plan I6–I9).
 *
 * A player cares where *they* stand, so their own row is highlighted wherever
 * it falls, and the scopes narrow from the whole world down to the zone they
 * actually play in.
 */
const SCOPES: { value: LeaderboardScope; label: string; needs?: "country" | "city" | "game" }[] = [
  { value: "global", label: "Global" },
  { value: "country", label: "Country", needs: "country" },
  { value: "city", label: "City", needs: "city" },
  { value: "zone", label: "My zone" },
  { value: "game", label: "By game", needs: "game" },
];

export default function RanksPage() {
  const { api, passport, playerId } = usePlayer();
  const [scope, setScope] = useState<LeaderboardScope>("global");
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await api.sessions.history({ limit: 5 }).catch(() => null);
      setZoneId(res?.sessions[0]?.zoneId ?? null);
    })();
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      try {
        const data = await api.leaderboard({
          scope,
          period: "all-time",
          zoneId: scope === "zone" ? zoneId ?? undefined : undefined,
          country: scope === "country" ? passport?.country ?? undefined : undefined,
          city: scope === "city" ? passport?.city ?? undefined : undefined,
          game: scope === "game" ? passport?.favoriteGames[0] : undefined,
          limit: 50,
        });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, scope, zoneId, passport]);

  const missing = (() => {
    if (scope === "country" && !passport?.country) return "Set your country in your profile.";
    if (scope === "city" && !passport?.city) return "Set your city in your profile.";
    if (scope === "game" && !passport?.favoriteGames.length)
      return "Add a favourite game to your profile.";
    if (scope === "zone" && !zoneId) return "Play a session and your zone board appears here.";
    return null;
  })();

  return (
    <>
      <h1>Ranks</h1>
      <p className="sub">
        {passport?.rank} · level {passport?.level}
      </p>

      <div className="scope-row">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            className="chip"
            data-active={scope === s.value}
            onClick={() => setScope(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <ErrorNote error={error} />

      <div className="card">
        {missing ? (
          <Empty>{missing}</Empty>
        ) : rows === null ? (
          <Loading rows={5} />
        ) : rows.length === 0 ? (
          <Empty>Nobody is on this board yet.</Empty>
        ) : (
          <div className="list">
            {rows.map((row) => {
              const isMe = row.playerId === playerId;
              return (
                <div className={`item${isMe ? " me" : ""}`} key={row.playerId}>
                  <span className="rank-pos" data-top={row.position <= 3}>
                    {row.position}
                  </span>
                  <div className="item__main">
                    <div className="item__title">
                      {row.username}
                      {isMe && <span className="faint"> · you</span>}
                    </div>
                    <div className="item__sub">
                      {row.rank} · level {row.level}
                    </div>
                  </div>
                  <div className="item__right">{row.xp.toLocaleString("en-IN")} XP</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
