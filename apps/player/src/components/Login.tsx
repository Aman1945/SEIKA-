"use client";

import { useState } from "react";

import { usePlayer } from "@/lib/session";

/** Player OTP sign-in (plan A1). One code, no password to forget or share. */
export function Login() {
  const { requestOtp, login } = usePlayer();
  const [step, setStep] = useState<"identifier" | "code">("identifier");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { devCode } = await requestOtp(identifier.trim());
      setStep("code");
      if (devCode) {
        setCode(devCode);
        setHint(`Development code: ${devCode}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">SEIKA</div>
        <p className="login__sub">Your gaming passport</p>

        {error && <div className="alert alert--error">{error}</div>}
        {hint && <div className="alert alert--info">{hint}</div>}

        {step === "identifier" ? (
          <form onSubmit={send}>
            <div className="field">
              <label htmlFor="id">Mobile number</label>
              <input
                id="id"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="9876543210"
                inputMode="tel"
                autoComplete="tel"
                required
                autoFocus
              />
            </div>
            <button className="btn--primary" disabled={busy || identifier.trim().length < 5}>
              {busy ? "Sending…" : "Send code"}
            </button>
            <p className="small faint center" style={{ marginTop: 14 }}>
              New here? Signing in creates your passport.
            </p>
          </form>
        ) : (
          <form onSubmit={verify}>
            <div className="field">
              <label htmlFor="code">Code sent to {identifier}</label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            </div>
            <button className="btn--primary" disabled={busy || code.length < 4}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              type="button"
              className="btn--ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                setStep("identifier");
                setCode("");
                setHint(null);
                setError(null);
              }}
            >
              Use a different number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
