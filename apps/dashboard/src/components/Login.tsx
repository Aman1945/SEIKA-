"use client";

import { useState } from "react";

import { useSession } from "@/lib/session";

/**
 * Staff OTP login (plan G1). No passwords anywhere in SEIKA — a shared counter
 * password is the thing that actually leaks in a gaming zone, so identity is
 * always a code sent to the person's own phone or email.
 */
export function Login() {
  const { requestOtp, login } = useSession();
  const [step, setStep] = useState<"identifier" | "code">("identifier");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { devCode } = await requestOtp(identifier.trim());
      setStep("code");
      // Outside production the API returns the code so a demo does not need a
      // real SMS. It is absent in production, and this line renders nothing.
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

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">SEIKA</div>
        <p className="login__sub">Zone console — owner and staff</p>

        {error && <div className="alert alert--error">{error}</div>}
        {hint && <div className="alert alert--info">{hint}</div>}

        {step === "identifier" ? (
          <form onSubmit={sendCode}>
            <div className="field">
              <label htmlFor="identifier">Staff phone or email</label>
              <input
                id="identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="9700000001"
                autoComplete="username"
                inputMode="email"
                required
                autoFocus
              />
            </div>
            <button className="btn--primary" style={{ width: "100%" }} disabled={busy || !identifier.trim()}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <div className="field">
              <label htmlFor="code">6-digit code sent to {identifier}</label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                // A numeric keypad and one-time-code autofill: this is typed on
                // a phone, at a counter, in a hurry.
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            </div>
            <button className="btn--primary" style={{ width: "100%" }} disabled={busy || code.length < 4}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              className="btn--sm"
              style={{ width: "100%", marginTop: 8, background: "transparent", border: "none" }}
              onClick={() => {
                setStep("identifier");
                setCode("");
                setHint(null);
                setError(null);
              }}
            >
              Use a different account
            </button>
          </form>
        )}

        <p className="small faint" style={{ marginTop: 18, marginBottom: 0 }}>
          Your role decides what you can see. The same permissions apply here as on desktop.
        </p>
      </div>
    </div>
  );
}
