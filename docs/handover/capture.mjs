/**
 * Screenshots the two SEIKA clients for the handover document.
 *
 * Drives headless Chrome over the DevTools Protocol with node's native
 * WebSocket — no Puppeteer, no extra dependencies. The tricky part is auth:
 * both apps keep their tokens in localStorage, so each capture seeds that for
 * the app's own origin before navigating.
 */

import fs from "node:fs/promises";
import path from "node:path";

const CDP = "http://127.0.0.1:9222";
const OUT = "/tmp/shots";

const demo = JSON.parse(await fs.readFile("/tmp/seika-demo.json", "utf8"));

/** Tokens as the apps store them. */
const staffTokens = JSON.stringify({
  accessToken: demo.owner,
  refreshToken: "seeded",
  subjectType: "staff",
});
const playerTokens = JSON.stringify({
  accessToken: demo.players[0].token,
  refreshToken: "seeded",
  subjectType: "player",
});

const SHOTS = [
  // Owner console — desktop
  { file: "dash-live", url: "http://localhost:3000/", w: 1440, h: 900, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-orders", url: "http://localhost:3000/orders", w: 1440, h: 900, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-sessions", url: "http://localhost:3000/sessions", w: 1440, h: 1000, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-revenue", url: "http://localhost:3000/analytics", w: 1440, h: 1250, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-shop", url: "http://localhost:3000/shop", w: 1440, h: 950, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-audit", url: "http://localhost:3000/audit", w: 1440, h: 950, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-migration", url: "http://localhost:3000/migration", w: 1440, h: 700, tokens: staffTokens, key: "seika.staff.tokens" },
  { file: "dash-events", url: "http://localhost:3000/events", w: 1440, h: 1000, tokens: staffTokens, key: "seika.staff.tokens" },

  // Owner console — phone, which is the plan's P0 case
  { file: "dash-mobile-live", url: "http://localhost:3000/", w: 390, h: 844, tokens: staffTokens, key: "seika.staff.tokens", mobile: true },
  { file: "dash-mobile-orders", url: "http://localhost:3000/orders", w: 390, h: 844, tokens: staffTokens, key: "seika.staff.tokens", mobile: true },

  // Player app — always a phone
  { file: "player-passport", url: "http://localhost:3001/", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },
  { file: "player-play", url: "http://localhost:3001/play", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },
  { file: "player-wallet", url: "http://localhost:3001/wallet", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },
  { file: "player-shop", url: "http://localhost:3001/shop", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },
  { file: "player-ranks", url: "http://localhost:3001/ranks", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },
  { file: "player-profile", url: "http://localhost:3001/profile", w: 390, h: 844, tokens: playerTokens, key: "seika.player.tokens", mobile: true },

  // Signed-out states
  { file: "dash-login", url: "http://localhost:3000/", w: 1440, h: 800, tokens: null, key: "seika.staff.tokens" },
  { file: "player-login", url: "http://localhost:3001/", w: 390, h: 844, tokens: null, key: "seika.player.tokens", mobile: true },
];

// ─── Minimal CDP client ──────────────────────────────────────────────────────

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function openTarget(url) {
  // A fresh tab per shot keeps one page's state from leaking into the next.
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Session(ws)));
    ws.addEventListener("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(shot) {
  const target = await openTarget("about:blank");
  const cdp = await connect(target.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: shot.w,
    height: shot.h,
    // 2x so the screenshots stay sharp when placed in a PDF.
    deviceScaleFactor: 2,
    mobile: Boolean(shot.mobile),
  });

  // Seed auth on the app's own origin before the app boots, or it renders the
  // login screen and then flickers.
  const origin = new URL(shot.url).origin;
  await cdp.send("Page.navigate", { url: origin });
  await sleep(700);
  await cdp.send("Runtime.evaluate", {
    expression: shot.tokens
      ? `localStorage.setItem(${JSON.stringify(shot.key)}, ${JSON.stringify(shot.tokens)})`
      : `localStorage.clear()`,
  });

  await cdp.send("Page.navigate", { url: shot.url });
  // The apps fetch after mount; this is long enough for the data to land.
  await sleep(3200);

  // Clip to where the content actually ends. `scrollHeight` is no use here:
  // both shells have a full-height sidebar or tab bar, so it is always at
  // least the viewport and a short page would still render as mostly empty
  // background.
  const measured = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const container = document.querySelector("main, .page");
      if (!container) return document.body.scrollHeight;
      let bottom = 0;
      for (const el of container.children) {
        const r = el.getBoundingClientRect();
        if (r.height > 0) bottom = Math.max(bottom, r.bottom + window.scrollY);
      }
      // Breathing room, plus the fixed tab bar on a phone layout.
      const tabBar = document.querySelector(".tabs, .nav");
      const reserve = tabBar && getComputedStyle(tabBar).position === "fixed"
        ? tabBar.getBoundingClientRect().height + 16
        : 24;
      return Math.ceil(bottom + reserve);
    })()`,
    returnByValue: true,
  });
  const contentHeight = Math.min(
    Math.max(Number(measured.result?.value) || shot.h, 260),
    shot.h
  );

  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    // No scale here — deviceScaleFactor already renders at 2x.
    clip: { x: 0, y: 0, width: shot.w, height: contentHeight, scale: 1 },
  });
  await fs.writeFile(path.join(OUT, `${shot.file}.png`), Buffer.from(data, "base64"));

  cdp.ws.close();
  await fetch(`${CDP}/json/close/${target.id}`);
  return `${shot.file}.png`;
}

await fs.mkdir(OUT, { recursive: true });
for (const shot of SHOTS) {
  try {
    const name = await capture(shot);
    console.log("captured", name);
  } catch (err) {
    console.error("FAILED", shot.file, err.message);
  }
}
