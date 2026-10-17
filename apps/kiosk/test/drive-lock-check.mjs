/**
 * Drives the real Electron kiosk through a full session and records what the
 * machine actually did at each step.
 *
 * The integration test proves the server *sends* the right commands. This
 * proves the shipped kiosk *obeys* them: it reads the lock screen's own DOM
 * before and after each step, and screenshots it, so "the PC unlocked" is an
 * observation rather than an inference.
 */

import fs from "node:fs/promises";

const KIOSK_CDP = "http://127.0.0.1:9333";
const API = "http://localhost:4000";
const OUT = "/tmp/kioskshots";

const seed = JSON.parse(await fs.readFile("/tmp/kiosk-seed.json", "utf8"));
const owner = seed.ownerAccessToken;
const pcId = seed.pc.id;

// ─── CDP ─────────────────────────────────────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const w = this.pending.get(m.id);
      if (w) {
        this.pending.delete(m.id);
        m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const targets = await (await fetch(`${KIOSK_CDP}/json`)).json();
const page = targets.find((t) => t.type === "page");
const cdp = await new Promise((res, rej) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("open", () => res(new Cdp(ws)));
  ws.addEventListener("error", rej);
});
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the lock screen is currently showing. */
async function kioskState() {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      locked: document.body.dataset.locked !== "false",
      reason: document.getElementById("reason")?.textContent.trim().slice(0, 80),
      net: document.getElementById("netText")?.textContent,
      beat: document.getElementById("beatText")?.textContent,
      hasQr: Boolean(document.querySelector("#qrHolder img")),
      banner: document.getElementById("banner")?.textContent.trim() || null,
    }))()`,
    returnByValue: true,
  });
  return result.value;
}

/**
 * Screenshots the lock screen, if it is on screen.
 *
 * An unlocked kiosk hides its window, and Chrome's captureScreenshot on a
 * hidden window never resolves — so this races a timeout rather than hanging
 * the whole check. A capture that times out while unlocked is not a failure;
 * it is the unlock working.
 */
async function shot(name) {
  const capture = cdp.send("Page.captureScreenshot", { format: "png" });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
  const result = await Promise.race([capture, timeout]);

  if (!result) {
    console.log(`      (no screenshot: the window is hidden, which is the unlock)`);
    return;
  }
  await fs.writeFile(`${OUT}/${name}.png`, Buffer.from(result.data, "base64"));
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const steps = [];
async function record(label, expectation) {
  await sleep(1200);
  const state = await kioskState();
  const pass = expectation(state);
  steps.push({ label, locked: state.locked, reason: state.reason, pass });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label}\n      locked=${state.locked}  "${state.reason}"`
  );
  return state;
}

// ─── Drive it ────────────────────────────────────────────────────────────────

console.log("\nDriving the real kiosk against the real server\n");

await record("at rest, before anyone sits down", (s) => s.locked === true);
await shot("01-locked-idle");

// A player signs in and is funded, exactly as a counter would do it.
const otp = await api("POST", "/api/auth/otp/request", { identifier: "9876511111" });
const tokens = await api("POST", "/api/auth/otp/verify", {
  identifier: "9876511111",
  code: otp.body.devCode,
});
const playerToken = tokens.body.accessToken;
const me = await api("GET", "/api/auth/me", undefined, playerToken);
const playerId = me.body.auth.sub;
await api("POST", "/api/wallet/topup", { playerId, amount: 500, method: "CASH" }, owner);

// 1. Scan the QR. Identity only — the PC must stay locked.
const qr = await api("POST", `/api/pcs/${pcId}/qr`, {}, owner);
const attach = await api("POST", "/api/sessions/attach", { qrToken: qr.body.token }, playerToken);
await record("after the QR scan (identity only)", (s) => s.locked === true);
await shot("02-locked-after-scan");

// 2. Authorize payment. Still locked.
const sessionId = attach.body.sessionId;
await api(
  "POST",
  `/api/sessions/${sessionId}/authorize`,
  { source: "WALLET", sessionMode: "FIXED_DURATION", selectedMinutes: 60 },
  playerToken
);
await record("after payment is authorized", (s) => s.locked === true);

// 3. Start the session. THIS is the unlock.
await api("POST", `/api/sessions/${sessionId}/start`, {}, playerToken);
await record("after the session starts — the server unlocks it", (s) => s.locked === false);
await shot("03-unlocked");

// 4. End the session. Back to locked.
await api("POST", `/api/sessions/${sessionId}/end`, {}, playerToken);
await record("after the session ends — the server re-locks it", (s) => s.locked === true);
await shot("04-locked-again");

// 5. A staff command straight from the console.
await api("POST", `/api/pcs/${pcId}/command`, { action: "unlock" }, owner);
await record("staff unlock from the console", (s) => s.locked === false);

await api("POST", `/api/pcs/${pcId}/command`, { action: "maintenance" }, owner);
await record("staff maintenance from the console", (s) => s.locked === true);
await shot("05-maintenance");

// ─── Verdict ─────────────────────────────────────────────────────────────────

const failed = steps.filter((s) => !s.pass);
console.log(`\n${steps.length - failed.length}/${steps.length} steps behaved as expected`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.label).join("; "));
  process.exitCode = 1;
}

cdp.ws.close();
