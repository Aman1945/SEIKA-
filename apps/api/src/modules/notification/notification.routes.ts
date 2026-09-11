import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { Notification } from "../../models/Notification.js";

export const notificationRouter = Router();
notificationRouter.use(requireAuth);

function playerOnly(req: any) {
  if (req.auth.typ !== "player") throw forbidden("Players only");
}

/** List own notifications (newest first) + unread count. */
notificationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    playerOnly(req);
    const q = z.object({ limit: z.coerce.number().min(1).max(50).default(20) }).parse(req.query);
    const [items, unread] = await Promise.all([
      Notification.find({ playerId: req.auth!.sub }).sort({ createdAt: -1 }).limit(q.limit).lean(),
      Notification.countDocuments({ playerId: req.auth!.sub, read: false }),
    ]);
    res.json({ ok: true, unread, notifications: items });
  })
);

notificationRouter.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    playerOnly(req);
    await Notification.updateOne({ _id: req.params.id, playerId: req.auth!.sub }, { read: true });
    res.json({ ok: true });
  })
);

notificationRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    playerOnly(req);
    await Notification.updateMany({ playerId: req.auth!.sub, read: false }, { read: true });
    res.json({ ok: true });
  })
);
