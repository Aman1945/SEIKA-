import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { GameSyncProfile } from "../../models/GameSyncProfile.js";
import { audit } from "../audit/audit.service.js";
import {
  downloadConfig,
  screenPaths,
  supportedGames,
  uploadConfig,
} from "./smartsync.service.js";

export const smartSyncRouter = Router();
smartSyncRouter.use(requireAuth);

/** Games Smart Sync supports, with the folders it may carry (plan K1). */
smartSyncRouter.get(
  "/games",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, games: await supportedGames() });
  })
);

/**
 * Pre-flight: the kiosk asks which of the files it found may actually sync.
 * Cheaper than uploading a bundle that will be refused, and it gives the kiosk
 * the exact list to pack.
 */
smartSyncRouter.post(
  "/screen",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const body = z
      .object({ game: z.string().min(1), paths: z.array(z.string()).max(2000) })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    res.json({ ok: true, ...(await screenPaths(body.data)) });
  })
);

/** Download the player's stored config before play starts (plan K2). */
smartSyncRouter.get(
  "/config/:game",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    res.json({
      ok: true,
      config: await downloadConfig({ playerId: req.auth!.sub, game: req.params.game }),
    });
  })
);

/** Upload the config after play (plan K3), with conflict handling (K4). */
smartSyncRouter.post(
  "/config/:game",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const body = z
      .object({
        payload: z.string().min(1),
        paths: z.array(z.string()).min(1).max(2000),
        baseVersion: z.number().int().nonnegative(),
        onConflict: z.enum(["abort", "overwrite"]).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const result = await uploadConfig({
      playerId: req.auth!.sub,
      game: req.params.game,
      ...body.data,
    });
    res.json({ ok: true, ...result });
  })
);

// ─── Profile administration (platform level) ─────────────────────────────────

/**
 * Only a platform admin vets which folders a game may sync. A zone owner
 * widening this for their own venue would put players' private files and
 * anti-cheat state at risk on every other zone too.
 */
smartSyncRouter.post(
  "/profiles",
  requireRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        game: z.string().min(1).max(80),
        syncPaths: z.array(z.string().min(1)).default([]),
        excludePaths: z.array(z.string().min(1)).default([]),
        enabled: z.boolean().default(false),
        notes: z.string().max(1000).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const profile = await GameSyncProfile.findOneAndUpdate(
      { game: body.data.game },
      body.data,
      { upsert: true, new: true, runValidators: true }
    );

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      action: "SMARTSYNC_PROFILE_SET",
      entityType: "smartsync",
      entityId: body.data.game,
      newValue: body.data,
    });

    res.status(201).json({ ok: true, profile });
  })
);

smartSyncRouter.get(
  "/profiles",
  requireRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, profiles: await GameSyncProfile.find().sort({ game: 1 }).lean() });
  })
);
