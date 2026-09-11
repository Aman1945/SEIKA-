import mongoose from "mongoose";
import { Product } from "../../models/Product.js";
import { Order } from "../../models/Order.js";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry, getWalletBalance } from "../wallet/wallet.service.js";
import { emitToZone } from "../realtime/io.js";
import { notify } from "../notification/notification.service.js";

export interface OrderItemInput {
  productId: string;
  qty: number;
}

/**
 * Resolves the seat a player is ordering from.
 *
 * The zone, PC and session are taken from the player's own live session — never
 * from the request body — so "order only from the zone you are seated in"
 * (testing plan H4/H5/H8) is enforced by construction rather than by trusting
 * a client-supplied zoneId.
 */
export async function resolveSeat(playerId: string): Promise<{
  sessionId: string;
  zoneId: string;
  pcId: string;
}> {
  const { Session } = await import("../../models/Session.js");
  const session = await Session.findOne({
    playerId,
    status: { $in: ["AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"] },
  })
    .sort({ createdAt: -1 })
    .select("_id zoneId pcId");

  if (!session) {
    throw badRequest("No active session — the seated-zone shop needs a live session");
  }
  return {
    sessionId: String(session._id),
    zoneId: String(session.zoneId),
    pcId: String(session.pcId),
  };
}

/**
 * Place a seat/shop order. Prices are resolved server-side (never trusted from
 * the client). Stock decrement + wallet deduction commit together in one txn.
 *
 * The order is bound to the player's active session, its PC and its zone.
 */
export async function placeOrder(params: {
  playerId: string;
  items: OrderItemInput[];
  paymentSource: "WALLET" | "CASH" | "SESSION_BILL";
  actorId: string;
  /** When the caller already knows the seat (staff flows); otherwise resolved. */
  seat?: { sessionId: string; zoneId: string; pcId: string };
  /** Zone the client *claims* to be ordering from; rejected if it disagrees. */
  claimedZoneId?: string;
}) {
  if (!params.items.length) throw badRequest("No items");

  const seat = params.seat ?? (await resolveSeat(params.playerId));
  // A client asking for another zone's shop is refused outright rather than
  // quietly served its own catalogue, so the mistake surfaces.
  if (params.claimedZoneId && params.claimedZoneId !== seat.zoneId) {
    throw forbidden("You can only order from the zone you are seated in");
  }

  const ids = params.items.map((i) => new mongoose.Types.ObjectId(i.productId));
  const products = await Product.find({ _id: { $in: ids }, zoneId: seat.zoneId, active: true });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  // Resolve line items + total server-side; validate stock.
  const lines = params.items.map((i) => {
    const p = byId.get(i.productId);
    if (!p) throw notFound(`Product ${i.productId} not found in zone`);
    if (i.qty <= 0) throw badRequest("qty must be positive");
    if (p.stockQty < i.qty) throw conflict(`Out of stock: ${p.name} (have ${p.stockQty})`);
    return { product: p, qty: i.qty, price: parseFloat(p.price.toString()) };
  });
  const total = +lines.reduce((s, l) => s + l.price * l.qty, 0).toFixed(2);

  const order = await withTransaction(async (txn) => {
    // Decrement stock atomically, guarding against oversell under concurrency.
    for (const l of lines) {
      const upd = await Product.updateOne(
        { _id: l.product._id, stockQty: { $gte: l.qty } },
        { $inc: { stockQty: -l.qty } },
        { session: txn }
      );
      if (upd.modifiedCount !== 1) throw conflict(`Out of stock: ${l.product.name}`);
    }

    if (params.paymentSource === "WALLET") {
      const balance = await getWalletBalance(params.playerId, seat.zoneId);
      if (balance < total) throw badRequest(`Insufficient balance (need ₹${total}, have ₹${balance})`);
      await addWalletEntry(
        {
          playerId: params.playerId,
          zoneId: seat.zoneId,
          amount: -total,
          type: "SHOP",
          method: "WALLET",
          reference: "shop-order",
          createdBy: params.actorId,
        },
        txn
      );
    }

    const [created] = await Order.create(
      [
        {
          playerId: params.playerId,
          zoneId: seat.zoneId,
          sessionId: seat.sessionId,
          pcId: seat.pcId,
          items: lines.map((l) => ({
            productId: l.product._id,
            name: l.product.name,
            qty: l.qty,
            price: l.product.price,
          })),
          total: mongoose.Types.Decimal128.fromString(total.toFixed(2)),
          paymentSource: params.paymentSource,
          status: "received",
        },
      ],
      { session: txn }
    );
    return created;
  });

  emitToZone(seat.zoneId, "order:new", {
    orderId: String(order._id),
    total,
    items: order.items.length,
    pcId: seat.pcId,
    sessionId: seat.sessionId,
  });
  return { order, total };
}

/** Staff moves an order along the queue. Cancel/refund restocks + credits wallet. */
export async function updateOrderStatus(
  orderId: string,
  status: "preparing" | "ready" | "delivered" | "cancelled",
  actorId: string
) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound("Order not found");
  if (["delivered", "cancelled", "refunded"].includes(order.status))
    throw badRequest(`Order already ${order.status}`);

  if (status === "cancelled") {
    await withTransaction(async (txn) => {
      // restock
      for (const it of order.items) {
        await Product.updateOne({ _id: it.productId }, { $inc: { stockQty: it.qty } }, { session: txn });
      }
      // refund wallet if paid by wallet
      if (order.paymentSource === "WALLET") {
        await addWalletEntry(
          {
            playerId: String(order.playerId),
            zoneId: String(order.zoneId),
            amount: parseFloat(order.total.toString()),
            type: "REFUND",
            method: "WALLET",
            reference: `order-cancel:${orderId}`,
            createdBy: actorId,
          },
          txn
        );
      }
      order.status = "cancelled";
      order.staffId = actorId;
      await order.save({ session: txn });
    });
  } else {
    order.status = status;
    order.staffId = actorId;
    await order.save();
  }

  emitToZone(String(order.zoneId), "order:status", { orderId, status: order.status });
  await notify({
    playerId: String(order.playerId),
    type: "ORDER",
    title: `Order ${order.status}`,
    body: `Your order is now ${order.status}.`,
    zoneId: String(order.zoneId),
  });
  return order;
}

/** Products low on stock in a zone. */
export async function lowStock(zoneId: string) {
  return Product.find({
    zoneId,
    active: true,
    $expr: { $lte: ["$stockQty", "$lowStockThreshold"] },
  }).lean();
}
