import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { Product } from "../../models/Product.js";
import { Order } from "../../models/Order.js";
import { Voucher } from "../../models/Voucher.js";
import { PlayerPackage } from "../../models/PlayerPackage.js";
import { placeOrder, updateOrderStatus, lowStock, resolveSeat } from "./shop.service.js";
import { audit } from "../audit/audit.service.js";

export const shopRouter = Router();
shopRouter.use(requireAuth);

/** Create a product (owner/manager). */
shopRouter.post(
  "/products",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        category: z.string().optional(),
        price: z.number().nonnegative(),
        cost: z.number().nonnegative().optional(),
        stockQty: z.number().int().nonnegative().default(0),
        lowStockThreshold: z.number().int().nonnegative().default(5),
        isPackage: z.boolean().optional(),
        packageMinutes: z.number().int().positive().optional(),
        branchId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const { price, cost, ...rest } = body.data;
    const product = await Product.create({
      ...rest,
      zoneId: req.tenantZoneId,
      price: mongoose.Types.Decimal128.fromString(price.toFixed(2)),
      cost: cost !== undefined ? mongoose.Types.Decimal128.fromString(cost.toFixed(2)) : undefined,
    });
    res.status(201).json({ ok: true, productId: String(product._id) });
  })
);

/** Update stock / activate. */
shopRouter.patch(
  "/products/:id",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ stockQty: z.number().int().optional(), active: z.boolean().optional() })
      .parse(req.body);
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, zoneId: req.tenantZoneId },
      body,
      { new: true }
    );
    if (!product) throw notFound("Product not found");
    res.json({ ok: true, product });
  })
);

/**
 * Catalogue for the current zone.
 *
 * Staff see their own tenant's products. A seated player sees the catalogue of
 * the zone they are actually seated in — the zone comes from their live session,
 * so asking for another zone's shop is refused rather than served (plan H3/H8).
 */
shopRouter.get(
  "/products",
  asyncHandler(async (req, res) => {
    let zoneId: string | undefined;
    if (req.auth!.typ === "staff") {
      zoneId = req.tenantZoneId;
    } else {
      const seat = await resolveSeat(req.auth!.sub);
      const claimed = req.query.zoneId as string | undefined;
      if (claimed && claimed !== seat.zoneId) {
        throw forbidden("You can only browse the shop of the zone you are seated in");
      }
      zoneId = seat.zoneId;
    }
    if (!zoneId) throw badRequest("zoneId required");
    const filter: Record<string, unknown> = { zoneId };
    if (req.auth!.typ === "player") filter.active = true;
    const products = await Product.find(filter).lean();
    res.json({
      ok: true,
      products: products.map((p) => ({
        ...p,
        price: parseFloat(p.price.toString()),
        cost: p.cost ? parseFloat(p.cost.toString()) : undefined,
      })),
    });
  })
);

shopRouter.get(
  "/low-stock",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone");
    res.json({ ok: true, products: await lowStock(req.tenantZoneId) });
  })
);

/** Owner/manager creates a free-play voucher. */
shopRouter.post(
  "/vouchers",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(3),
        value: z.number().int().positive(),
        maxRedemptions: z.number().int().positive().default(1),
        validUntil: z.coerce.date().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone");
    const v = await Voucher.create({ ...body.data, code: body.data.code.toUpperCase(), zoneId: req.tenantZoneId });
    res.status(201).json({ ok: true, voucherId: String(v._id), code: v.code });
  })
);

/** Owner/manager grants a playtime package to a player. */
shopRouter.post(
  "/packages/grant",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ playerId: z.string(), minutes: z.number().int().positive() })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone");
    const pkg = await PlayerPackage.create({
      playerId: body.data.playerId,
      zoneId: req.tenantZoneId,
      minutesRemaining: body.data.minutes,
    });
    res.status(201).json({ ok: true, packageId: String(pkg._id), minutesRemaining: pkg.minutesRemaining });
  })
);

/** Player places a seat order. */
shopRouter.post(
  "/orders",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const body = z
      .object({
        // The seat (zone + PC + session) comes from the player's live session,
        // so these are only ever treated as a claim to be checked.
        zoneId: z.string().optional(),
        items: z.array(z.object({ productId: z.string(), qty: z.number().int().positive() })).min(1),
        paymentSource: z.enum(["WALLET", "CASH", "SESSION_BILL"]).default("WALLET"),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    const result = await placeOrder({
      items: body.data.items,
      paymentSource: body.data.paymentSource,
      claimedZoneId: body.data.zoneId,
      playerId: req.auth!.sub,
      actorId: req.auth!.sub,
    });
    res.status(201).json({
      ok: true,
      orderId: String(result.order._id),
      total: result.total,
      status: result.order.status,
      zoneId: String(result.order.zoneId),
      pcId: String(result.order.pcId),
      sessionId: String(result.order.sessionId),
    });
  })
);

/** Live order queue for staff. */
shopRouter.get(
  "/orders/queue",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const orders = await Order.find({
      zoneId: req.tenantZoneId,
      status: { $in: ["received", "preparing", "ready"] },
    })
      .sort({ createdAt: 1 })
      .lean();
    res.json({
      ok: true,
      // Decimal128 has to be converted on the way out — including the per-line
      // prices, not just the total. A client doing `price * qty` on the raw
      // Decimal object silently gets NaN.
      orders: orders.map((o) => ({
        ...o,
        total: parseFloat(o.total.toString()),
        items: (o.items ?? []).map((i) => ({
          ...i,
          price: i.price ? parseFloat(i.price.toString()) : 0,
        })),
      })),
    });
  })
);

/** Staff advances order status. */
shopRouter.patch(
  "/orders/:id/status",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(["preparing", "ready", "delivered", "cancelled"]) })
      .parse(req.body);
    const order = await updateOrderStatus(req.params.id, status, req.auth!.sub);
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: `ORDER_${status.toUpperCase()}`,
      entityType: "order",
      entityId: req.params.id,
    });
    res.json({ ok: true, status: order.status });
  })
);
