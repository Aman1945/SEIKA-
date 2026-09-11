import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { PC } from "../../models/PC.js";

let io: Server | null = null;

/**
 * Rooms:
 *   zone:{zoneId}  → owner dashboards (all PC/session updates for a zone)
 *   pc:{pcId}      → the kiosk on that PC (trusted commands)
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.corsOrigins, credentials: true } });

  io.on("connection", (socket) => {
    // Dashboard joins a zone room.
    socket.on("join:zone", (zoneId: string) => {
      if (zoneId) socket.join(`zone:${zoneId}`);
    });

    // Kiosk joins its PC room after proving the clientKey.
    socket.on("join:pc", async (data: { pcId: string; clientKey: string }) => {
      const pc = await PC.findById(data?.pcId);
      if (!pc || pc.clientKey !== data?.clientKey) {
        socket.emit("error:auth", { message: "Invalid PC clientKey" });
        return;
      }
      socket.join(`pc:${data.pcId}`);
      socket.join(`zone:${pc.zoneId}`);
      socket.emit("joined:pc", { pcId: data.pcId });
    });

    socket.on("disconnect", () => {});
  });

  logger.info("Realtime (Socket.IO) initialized");
  return io;
}

export function emitToZone(zoneId: string, event: string, payload: unknown) {
  io?.to(`zone:${zoneId}`).emit(event, payload);
}

export function emitToPc(pcId: string, event: string, payload: unknown) {
  io?.to(`pc:${pcId}`).emit(event, payload);
}
