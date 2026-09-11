"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { SessionRow } from "@seika/types";

import { usePlayer } from "@/lib/session";
import { Elapsed, Empty, ErrorNote, Loading, dateTime, duration, money } from "@/components/ui";

/**
 * The passport (plan F1, F2, F3).
 *
 * One screen answering what a player actually opens the app for: how much do I
 * have, am I playing, and how far am I from the next level. Everything else is
 * a tab away.
 */
export default function PassportPage() {
  const { api, passport, refresh } = usePlayer();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.sessions.history({ limit: 20 });
        if (!cancelled) setSessions(res.sessions);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // Coming back to this tab after playing should show the new numbers.
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [api, refresh]);

  if (!passport) return <Loading rows={4} />;

  const live = sessions?.find((s) =>
    ["AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"].includes(s.status)
  );
  const past = (sessions ?? []).filter((s) => s.status === "COMPLETED");
  const totalMinutes = past.reduce((sum, s) => sum + (s.validMinutes ?? 0), 0);

  const initial = (passport.gamerTag ?? passport.name ?? "P").trim().charAt(0).toUpperCase();
  const xpToGo = Math.max(0, passport.xp.nextLevelAt - passport.xp.total);

  return (
    <>
      <div className="passport">
        <div className="passport__top">
          <div className="passport__avatar">{initial}</div>
          <div>
            <div className="passport__name">{passport.gamerTag ?? passport.name}</div>
            <div className="passport__rank">
              {passport.rank}
              {passport.city && <> · {passport.city}</>}
            </div>
          </div>
          <div className="passport__level">
            <div className="passport__level-num">{passport.level}</div>
            <div className="passport__level-label">Level</div>
          </div>
        </div>

        <div className="xpbar">
          <div className="xpbar__fill" style={{ width: `${Math.round(passport.xp.progress * 100)}%` }} />
        </div>
        <div className="passport__xp">
          <span>{passport.xp.total.toLocaleString("en-IN")} XP</span>
          <span>{xpToGo > 0 ? `${xpToGo.toLocaleString("en-IN")} to level ${passport.level + 1}` : "Max level"}</span>
        </div>

        <div className="passport__wallet">
          <div className="wallet-chip">
            <div className="wallet-chip__label">Wallet</div>
            <div className="wallet-chip__value">{money(passport.wallet.balance)}</div>
          </div>
          <div className="wallet-chip">
            <div className="wallet-chip__label">SEIKA Coins</div>
            <div className="wallet-chip__value">{passport.coins.toLocaleString("en-IN")}</div>
          </div>
        </div>
      </div>

      {live && (
        <Link href="/play" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="playing">
            <div className="playing__label">
              {live.status === "ACTIVE" ? "Playing now" : "Waiting to start"}
            </div>
            {live.startTime ? (
              <Elapsed since={live.startTime} big />
            ) : (
              <div className="playing__time">--:--</div>
            )}
            <div className="playing__meta">
              {live.sessionMode === "FIXED_DURATION"
                ? `${(live.selectedMinutes ?? 0) / 60} hour block`
                : "Open hour · charged per minute"}
              {live.game && <> · {live.game}</>}
            </div>
          </div>
        </Link>
      )}

      {!live && (
        <Link href="/play" className="btn btn--primary" style={{ marginBottom: 16 }}>
          Scan a PC to start playing
        </Link>
      )}

      <div className="card">
        <h2 className="card__title">Your play</h2>
        <div className="row" style={{ gap: 16 }}>
          <div>
            <div className="small faint">Total played</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{duration(totalMinutes)}</div>
          </div>
          <div>
            <div className="small faint">Sessions</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{past.length}</div>
          </div>
          <div>
            <div className="small faint">Bookings</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{passport.stats.bookings}</div>
          </div>
        </div>
      </div>

      {passport.favoriteGames.length > 0 && (
        <div className="card">
          <h2 className="card__title">Your games</h2>
          <div className="row row--wrap">
            {passport.favoriteGames.map((g) => (
              <span key={g} className="badge" data-tone="idle">
                {g}
              </span>
            ))}
          </div>
        </div>
      )}

      <h2>Recent sessions</h2>
      <ErrorNote error={error} />
      <div className="card">
        {sessions === null ? (
          <Loading rows={3} />
        ) : past.length === 0 ? (
          <Empty>No sessions yet. Scan a PC to start your first one.</Empty>
        ) : (
          <div className="list">
            {past.slice(0, 10).map((s) => (
              <div className="item" key={s._id}>
                <div className="item__main">
                  <div className="item__title">
                    {duration(s.validMinutes)}
                    {s.game && <span className="faint"> · {s.game}</span>}
                  </div>
                  <div className="item__sub">{dateTime(s.endTime)}</div>
                </div>
                <div className="item__right">
                  <div>{money(s.cost)}</div>
                  <div className="small pos">+{s.xpAwarded} XP</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Link href="/profile" className="btn btn--ghost">
        Edit profile
      </Link>
    </>
  );
}
