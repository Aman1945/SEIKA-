import { Notification } from "../../models/Notification.js";
import { emitToZone } from "../realtime/io.js";

/** Create a player notification (and push it live to the zone room). */
export async function notify(params: {
  playerId: string;
  type: string;
  title: string;
  body?: string;
  zoneId?: string;
}) {
  try {
    const n = await Notification.create({
      playerId: params.playerId,
      type: params.type,
      title: params.title,
      body: params.body,
    });
    if (params.zoneId)
      emitToZone(params.zoneId, "notification", { playerId: params.playerId, type: params.type, title: params.title });
    return n;
  } catch {
    return null; // notifications must never break the main flow
  }
}
