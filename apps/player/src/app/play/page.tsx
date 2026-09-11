"use client";

import { useCallback, useEffect, useState } from "react";

import type { SessionRow } from "@seika/types";

import { usePlayer } from "@/lib/session";
import { Elapsed, ErrorNote, Loading, duration, money } from "@/components/ui";

/**
 * The core loop, from the player's side (plan B1–B3, C3–C6).
 *
 * The rule this screen exists to make honest: scanning a QR identifies you, it
 * does not unlock the PC. So the flow is deliberately two steps — attach, then
 * choose and pay — and the price of the choice is shown before it is made,
 * never after.
 */
type Step = "idle" | "attached" | "playing";

const BLOCKS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 180, label: "3 hours" },
];

export default function PlayPage() {
  const { api, passport, refresh } = usePlayer();

  const [step, setStep] = useState<Step>("idle");
  const [session, setSession] = useState<SessionRow | null>(null);
  const [qrToken, setQrToken] = useState("");
  const [choice, setChoice] = useState<number | "open">(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const balance = passport?.wallet.balance ?? 0;

  /** A live session survives a refresh or a closed tab, so look for one first. */
  const findLive = useCallback(async () => {
    try {
      const res = await api.sessions.history({ limit: 10 });
      const live = res.sessions.find((s) =>
        ["PENDING_AUTH", "AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"].includes(s.status)
      );
      if (live) {
        setSession(live);
        setStep(live.status === "PENDING_AUTH" ? "attached" : "playing");
      } else {
        setSession(null);
        setStep("idle");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void findLive();
  }, [findLive]);

  async function attach(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.sessions.attach(qrToken.trim());
      const full = await api.sessions.byId(res.sessionId);
      setSession(full.session);
      setStep("attached");
      setQrToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fixed = choice !== "open";
      const auth = await api.sessions.authorize(session._id, {
        source: "WALLET",
        sessionMode: fixed ? "FIXED_DURATION" : "OPEN_HOUR",
        selectedMinutes: fixed ? (choice as number) : undefined,
      });

      if (!auth.authorized) {
        // The API says exactly what is needed; repeating it is more useful than
        // "payment failed".
        setError(
          auth.reason === "INSUFFICIENT_BALANCE"
            ? `You need ${money(auth.minStartAmount)} to start this. Your balance is ${money(auth.balance)}.`
            : `Could not start: ${auth.reason ?? "unknown reason"}`
        );
        return;
      }

      await api.sessions.start(session._id);
      await findLive();
      await refresh();
      setStep("playing");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!session) return;
    if (!window.confirm("End your session? The PC will lock.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.sessions.end(session._id);
      setNotice(
        `Played ${duration(res.validMinutes)} · charged ${money(res.cost)} · earned ${res.xp.gained} XP` +
          (res.xp.leveledUp ? ` · levelled up to ${res.xp.level}!` : "")
      );
      await findLive();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const rate = 60; // the PC's hourly rate arrives with the authorize response
  const costOf = (minutes: number) => (rate * minutes) / 60;

  if (loading) return <Loading rows={4} />;

  return (
    <>
      <h1>Play</h1>

      <ErrorNote error={error} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      {step === "playing" && session && (
        <>
          <div className="playing">
            <div className="playing__label">
              {session.status === "ACTIVE" ? "Playing now" : session.status.replace(/_/g, " ")}
            </div>
            {session.startTime ? <Elapsed since={session.startTime} big /> : <div className="playing__time">--:--</div>}
            <div className="playing__meta">
              {session.sessionMode === "FIXED_DURATION"
                ? `${(session.selectedMinutes ?? 0) / 60} hour block · ends automatically`
                : "Open hour · charged for the minutes you play"}
            </div>
          </div>

          <div className="card">
            <h2 className="card__title">While you play</h2>
            <p className="small faint" style={{ marginTop: 0 }}>
              Order from the shop tab and it comes to this seat — you never have to say which PC
              you are on.
            </p>
          </div>

          <button className="btn--ghost" disabled={busy} onClick={() => void end()}>
            End session
          </button>
        </>
      )}

      {step === "attached" && session && (
        <>
          <div className="alert alert--info">
            You are attached to the PC, and it is still locked. Choose how long you want to play —
            the PC unlocks once that is paid for.
          </div>

          <div className="hours">
            {BLOCKS.map((b) => {
              const cost = costOf(b.minutes);
              const affordable = balance >= cost;
              return (
                <button
                  key={b.minutes}
                  className="hour"
                  data-selected={choice === b.minutes}
                  data-affordable={affordable}
                  onClick={() => setChoice(b.minutes)}
                >
                  <span className="hour__label">{b.label}</span>
                  <span className="hour__price">{money(cost)}</span>
                  {!affordable && <span className="hour__note">not enough balance</span>}
                </button>
              );
            })}
            <button
              className="hour"
              data-selected={choice === "open"}
              data-affordable={balance >= costOf(15)}
              onClick={() => setChoice("open")}
            >
              <span className="hour__label">Open hour</span>
              <span className="hour__price">{money(rate)}/hr</span>
              <span className="hour__note">pay for what you play</span>
            </button>
          </div>

          <div className="card">
            <div className="row">
              <span className="dim">Your balance</span>
              <span className="spacer num" style={{ fontWeight: 700 }}>
                {money(balance)}
              </span>
            </div>
            <div className="row small faint" style={{ marginTop: 4 }}>
              <span>{choice === "open" ? "Minimum to start" : "You will be charged"}</span>
              <span className="spacer num">
                {money(choice === "open" ? costOf(15) : costOf(choice as number))}
              </span>
            </div>
          </div>

          <button className="btn--primary" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting…" : "Start playing"}
          </button>
        </>
      )}

      {step === "idle" && (
        <>
          <p className="sub">
            Scan the code on the PC screen. That tells us who you are — the PC unlocks after you
            choose and pay for your time.
          </p>

          <form onSubmit={attach} className="card">
            <div className="field">
              <label htmlFor="qr">Code from the PC screen</label>
              <input
                id="qr"
                value={qrToken}
                onChange={(e) => setQrToken(e.target.value)}
                placeholder="Paste or scan"
                autoComplete="off"
                required
              />
            </div>
            <button className="btn--primary" disabled={busy || !qrToken.trim()}>
              {busy ? "Checking…" : "Attach to this PC"}
            </button>
            <p className="small faint" style={{ marginBottom: 0, marginTop: 10 }}>
              A camera scanner replaces this field on a phone with camera permission; the code is
              short-lived either way.
            </p>
          </form>

          {balance < 60 && (
            <div className="alert alert--info">
              Your balance is {money(balance)}. Top up from the wallet tab before you scan, or ask
              at the counter.
            </div>
          )}
        </>
      )}
    </>
  );
}
