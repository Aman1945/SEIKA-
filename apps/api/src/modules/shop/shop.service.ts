import mongoose from "mongoose";
import { Product } from "../../models/Product.js";
import { Order } from "../../models/Order.js";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry, getWalletBalance } from "../wallet/wallet.service.js";
import { emitToZone } from "../realtime/io.js";
import { notify } from "../notification/notification.service.js";

export interface OrderItemInput {
  productId: string;
  qty: number;
}

/**
 * Place a seat/shop order. Prices are resolved server-side (never trusted from
 * the client). Stock decrement + wallet deduction commit together in one txn.
 */
export async function placeOrder(params: {
  playerId: string;
  zoneId: string;
  items: OrderItemInput[];
  paymentSource: "WALLET" | "CASH" | "SESSION_BILL";
  sessionId?: string;
  pcId?: string;
  actorId: string;
}) {
  if (!params.items.length) throw badRequest("No items");

  const ids = params.items.map((i) => new mongoose.Types.ObjectId(i.productId));
  const products = await Product.find({ _id: { $in: ids }, zoneId: params.zoneId, active: true });
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
      const balance = await getWalletBalance(params.playerId, params.zoneId);
      if (balance < total) throw badRequest(`Insufficient balance (need ₹${total}, have ₹${balance})`);
      await addWalletEntry(
        {
          playerId: params.playerId,
          zoneId: params.zoneId,
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
          zoneId: params.zoneId,
          sessionId: params.sessionId,
          pcId: params.pcId,
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

  emitToZone(params.zoneId, "order:new", {
    orderId: String(order._id),
    total,
    items: order.items.length,
    pcId: params.pcId,
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
