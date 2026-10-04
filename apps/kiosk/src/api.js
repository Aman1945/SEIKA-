"use strict";

/**
 * The kiosk's view of the API.
 *
 * Small on purpose: a kiosk authenticates with its `clientKey`, not a user
 * token, and it is only ever allowed to do three things — say it is alive,
 * ask for a QR token to display, and carry out Smart Sync on behalf of the
 * player sitting at it. It never decides anything.
 */

const TIMEOUT_MS = 8_000;

class KioskApi {
  constructor(config) {
    this.baseUrl = String(config.apiUrl ?? "").replace(/\/$/, "");
    this.pcId = config.pcId;
    this.clientKey = config.clientKey;
  }

  async request(path, { method = "GET", body, token } = {}) {
    const controller = new AbortController();
    // A hung request must not stall the heartbeat loop: a zone's network drops,
    // and a kiosk that stops reporting looks identical to a kiosk that is off.
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;

      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
        err.status = res.status;
        err.code = json?.error?.code;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Says this PC is alive. Authenticated by the clientKey, not a user token. */
  heartbeat() {
    return this.request(`/api/pcs/${this.pcId}/heartbeat`, {
      method: "POST",
      body: { clientKey: this.clientKey },
    });
  }

  /**
   * A fresh QR token to display. These are short-lived by design, so the
   * lock screen re-asks well before expiry rather than showing a dead code.
   */
  qrToken(staffToken) {
    return this.request(`/api/pcs/${this.pcId}/qr`, { method: "POST", token: staffToken });
  }

  health() {
    return this.request("/health");
  }

  /**
   * Reports uses of the local staff escape. Batched because an outage is
   * exactly when the escape gets used and the report cannot be delivered, so
   * several may be owed at once.
   */
  reportStaffEscape(entries) {
    return this.request(`/api/pcs/${this.pcId}/staff-escape`, {
      method: "POST",
      body: { clientKey: this.clientKey, uses: entries },
    });
  }

  // ─── Smart Sync, on behalf of the seated player ───────────────────────────

  syncGames(playerToken) {
    return this.request("/api/smartsync/games", { token: playerToken });
  }

  screenPaths(playerToken, game, paths) {
    return this.request("/api/smartsync/screen", {
      method: "POST",
      token: playerToken,
      body: { game, paths },
    });
  }

  downloadConfig(playerToken, game) {
    return this.request(`/api/smartsync/config/${encodeURIComponent(game)}`, {
      token: playerToken,
    });
  }

  uploadConfig(playerToken, game, payload) {
    return this.request(`/api/smartsync/config/${encodeURIComponent(game)}`, {
      method: "POST",
      token: playerToken,
      body: payload,
    });
  }
}

module.exports = { KioskApi };
