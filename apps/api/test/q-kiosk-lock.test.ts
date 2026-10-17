import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";

import { createApp } from "../src/app.js";
import { initRealtime } from "../src/modules/realtime/io.js";
import {
  as,
  qrFor,
  seedPc,
  seedPlayer,
  seedStaff,
  seedZone,
  type SeededZone,
} from "./helpers/factories.js";
import { PC } from "../src/models/PC.js";

/**
 * Does the server actually lock and unlock the PC?
 *
 * Every other test in this suite talks to the API through supertest, which
 * never starts a real HTTP server and therefore never exercises Socket.IO.
 * But the lock is not an API response — it is a message pushed down a socket to
 * a specific machine. A kiosk that never receives it is a PC that never
 * unlocks, and nothing else here would notice.
 *
 * So these cases run a real server, connect a real socket client standing in
 * for the kiosk, and assert on what that machine is actually told.
 */

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(createApp());
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A stand-in for the kiosk: joins its PC room and records what it is told. */
class FakeKiosk {
  readonly received: { action: string; sessionId?: string }[] = [];
  readonly authErrors: string[] = [];
  private socket!: Socket;

  async connect(pcId: string, clientKey: string): Promise<void> {
    this.socket = io(baseUrl, { transports: ["websocket"], forceNew: true });

    this.socket.on("command", (payload: { action: string; sessionId?: string }) => {
      this.received.push(payload);
    });
    this.socket.on("error:auth", (payload: { message?: string }) => {
      this.authErrors.push(payload?.message ?? "auth error");
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not connect")), 5_000);
      this.socket.on("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.on("connect_error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    this.socket.emit("join:pc", { pcId, clientKey });
    // The server joins the room asynchronously; a command emitted before that
    // lands nowhere, which is exactly the race a real kiosk hits on reconnect.
    await this.settle();
  }

  /** Waits for in-flight socket work to land. */
  settle(ms = 250): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Waits for a specific command, or fails rather than hanging. */
  async waitFor(action: string, timeoutMs = 3_000): Promise<{ action: string; sessionId?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.received.find((c) => c.action === action);
      if (hit) return hit;
      await this.settle(50);
    }
    throw new Error(
      `Never received "${action}". Got: ${JSON.stringify(this.received)}`
    );
  }

  get actions(): string[] {
    return this.received.map((c) => c.action);
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}

/** Drives a player from QR scan to an unlocked PC. */
async function playUpTo(
  zone: SeededZone,
  playerToken: string,
  step: "attach" | "authorize" | "start",
  pcId?: string
): Promise<string> {
  const target = pcId ?? zone.pcId;
  const attach = await as(playerToken)
    .post("/api/sessions/attach")
    .send({ qrToken: qrFor(target) });
  const sessionId = attach.body.sessionId as string;
  if (step === "attach") return sessionId;

  await as(playerToken)
    .post(`/api/sessions/${sessionId}/authorize`)
    .send({ source: "WALLET", sessionMode: "OPEN_HOUR" });
  if (step === "authorize") return sessionId;

  await as(playerToken).post(`/api/sessions/${sessionId}/start`).send({});
  return sessionId;
}

describe("Q. Server-driven PC lock", () => {
  it("the PC is told to unlock only when a session actually starts", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const kiosk = new FakeKiosk();
    await kiosk.connect(zone.pcId, zone.pcClientKey);

    try {
      // Scanning the QR identifies the player. The PC must hear nothing.
      await playUpTo(zone, player.token, "attach");
      await kiosk.settle(400);
      expect(kiosk.actions).toEqual([]);

      // Authorizing proves they can pay. Still not an unlock — the engine has
      // approved the money, the session has not begun.
      const sessionId = await playUpTo(zone, player.token, "authorize");
      await kiosk.settle(400);
      expect(kiosk.actions).toEqual([]);

      // Starting is what unlocks it.
      await as(player.token).post(`/api/sessions/${sessionId}/start`).send({});
      const unlock = await kiosk.waitFor("unlock");
      expect(unlock.sessionId).toBe(sessionId);

      // And the PC is marked occupied, so the dashboard agrees with the kiosk.
      const pc = await PC.findById(zone.pcId).lean();
      expect(pc!.status).toBe("OCCUPIED");
    } finally {
      kiosk.disconnect();
    }
  });

  it("ending the session tells the PC to lock again", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const kiosk = new FakeKiosk();
    await kiosk.connect(zone.pcId, zone.pcClientKey);

    try {
      const sessionId = await playUpTo(zone, player.token, "start");
      await kiosk.waitFor("unlock");

      await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
      const lock = await kiosk.waitFor("lock");
      expect(lock.sessionId).toBe(sessionId);

      // The full shape of a session, as the machine experienced it.
      expect(kiosk.actions).toEqual(["unlock", "lock"]);

      const pc = await PC.findById(zone.pcId).lean();
      expect(["AVAILABLE", "CLEANING"]).toContain(String(pc!.status));
    } finally {
      kiosk.disconnect();
    }
  });

  it("a player who cannot pay never causes an unlock", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const broke = await seedPlayer({ balance: 5, zoneId: zone.zoneId });

    const kiosk = new FakeKiosk();
    await kiosk.connect(zone.pcId, zone.pcClientKey);

    try {
      const attach = await as(broke.token)
        .post("/api/sessions/attach")
        .send({ qrToken: qrFor(zone.pcId) });

      const auth = await as(broke.token)
        .post(`/api/sessions/${attach.body.sessionId}/authorize`)
        .send({ source: "WALLET", sessionMode: "OPEN_HOUR" });
      expect(auth.status).toBe(402);

      // Starting an unauthorized session must be refused, and the machine must
      // hear nothing at all. This is the core rule, observed from the PC's end.
      const start = await as(broke.token)
        .post(`/api/sessions/${attach.body.sessionId}/start`)
        .send({});
      expect(start.status).toBeGreaterThanOrEqual(400);

      await kiosk.settle(500);
      expect(kiosk.actions).toEqual([]);
    } finally {
      kiosk.disconnect();
    }
  });

  it("staff lock, unlock and maintenance commands reach the machine", async () => {
    const zone = await seedZone();
    const technician = await seedStaff(zone, "TECHNICIAN");

    const kiosk = new FakeKiosk();
    await kiosk.connect(zone.pcId, zone.pcClientKey);

    try {
      for (const action of ["lock", "unlock", "restart", "maintenance"]) {
        const res = await as(technician.token)
          .post(`/api/pcs/${zone.pcId}/command`)
          .send({ action });
        expect(res.status, action).toBe(200);
      }

      await kiosk.waitFor("maintenance");
      expect(kiosk.actions).toEqual(["lock", "unlock", "restart", "maintenance"]);
    } finally {
      kiosk.disconnect();
    }
  });

  it("a command for one PC never reaches another", async () => {
    const zone = await seedZone();
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const technician = await seedStaff(zone, "TECHNICIAN");

    const kioskA = new FakeKiosk();
    const kioskB = new FakeKiosk();
    await kioskA.connect(zone.pcId, zone.pcClientKey);
    await kioskB.connect(other.pcId, other.clientKey);

    try {
      await as(technician.token).post(`/api/pcs/${zone.pcId}/command`).send({ action: "unlock" });
      await kioskA.waitFor("unlock");

      // Unlocking one PC must not unlock the one next to it.
      await kioskB.settle(500);
      expect(kioskB.actions).toEqual([]);
    } finally {
      kioskA.disconnect();
      kioskB.disconnect();
    }
  });

  it("a PC with the wrong clientKey is refused and receives nothing", async () => {
    const zone = await seedZone();
    const technician = await seedStaff(zone, "TECHNICIAN");

    const impostor = new FakeKiosk();
    await impostor.connect(zone.pcId, "not-the-right-key");

    try {
      // The join is rejected outright...
      expect(impostor.authErrors.length).toBeGreaterThan(0);
      expect(impostor.authErrors[0]).toMatch(/clientKey/i);

      // ...so a real unlock for that PC does not reach it. Otherwise anyone who
      // learned a PC id could listen for unlocks on a machine they control.
      await as(technician.token).post(`/api/pcs/${zone.pcId}/command`).send({ action: "unlock" });
      await impostor.settle(500);
      expect(impostor.actions).toEqual([]);
    } finally {
      impostor.disconnect();
    }
  });

  it("another zone's staff cannot command this zone's PC", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });

    const kiosk = new FakeKiosk();
    await kiosk.connect(zoneA.pcId, zoneA.pcClientKey);

    try {
      const res = await as(zoneB.ownerToken)
        .post(`/api/pcs/${zoneA.pcId}/command`)
        .send({ action: "unlock" });
      expect(res.status).toBe(403);

      await kiosk.settle(500);
      expect(kiosk.actions).toEqual([]);
    } finally {
      kiosk.disconnect();
    }
  });

  it("a kiosk that reconnects still receives commands", async () => {
    const zone = await seedZone();
    const technician = await seedStaff(zone, "TECHNICIAN");

    const kiosk = new FakeKiosk();
    await kiosk.connect(zone.pcId, zone.pcClientKey);
    kiosk.disconnect();

    // Room membership does not survive a disconnect, so a kiosk that rejoins
    // has to be told again — a silently-empty stream looks exactly like a
    // quiet PC, which is how a zone ends up with a machine nobody can unlock.
    const rejoined = new FakeKiosk();
    await rejoined.connect(zone.pcId, zone.pcClientKey);

    try {
      await as(technician.token).post(`/api/pcs/${zone.pcId}/command`).send({ action: "unlock" });
      const unlock = await rejoined.waitFor("unlock");
      expect(unlock.action).toBe("unlock");
    } finally {
      rejoined.disconnect();
    }
  });

  it("the kiosk heartbeat is what marks a PC reachable", async () => {
    const zone = await seedZone();

    const before = await PC.findById(zone.pcId).lean();
    expect(before!.lastHeartbeatAt ?? null).toBeNull();

    const res = await as(zone.ownerToken)
      .post(`/api/pcs/${zone.pcId}/heartbeat`)
      .send({ clientKey: zone.pcClientKey });
    expect(res.status).toBe(200);

    const after = await PC.findById(zone.pcId).lean();
    expect(after!.lastHeartbeatAt).toBeTruthy();

    // A wrong key must not be able to fake a PC being alive.
    const forged = await as(zone.ownerToken)
      .post(`/api/pcs/${zone.pcId}/heartbeat`)
      .send({ clientKey: "wrong" });
    expect(forged.status).toBe(403);
  });
});
