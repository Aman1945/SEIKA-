"use client";

import { useState } from "react";

import type { OrderRow, OrderStatus } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import {
  Elapsed,
  Empty,
  ErrorNote,
  Loading,
  StatusBadge,
  money,
  shortId,
  useConfirm,
} from "@/components/ui";

/**
 * The seat-order queue (plan G4).
 *
 * Every order is bound server-side to the session, PC and zone it was placed
 * from, so the seat shown here is the seat the drink goes to — nobody types a
 * PC number and gets it wrong.
 *
 * This screen is push-driven: an order appearing a few seconds late is how
 * staff learn to stop trusting the queue and start shouting across the room.
 */
const NEXT_STATUS: Partial<Record<OrderStatus, { next: Exclude<OrderStatus, "received" | "refunded">; label: string }>> = {
  received: { next: "preparing", label: "Start preparing" },
  preparing: { next: "ready", label: "Mark ready" },
  ready: { next: "delivered", label: "Delivered" },
};

export default function OrdersPage() {
  const { api, staff } = useSession();
  const stream = useZoneStream(staff?.zoneId);
  const confirm = useConfirm();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queue = useLiveData(() => api.shop.queue(), {
    revision: stream.revision,
    fallbackMs: 15_000,
  });

  const orders = queue.data ?? [];

  async function advance(order: OrderRow) {
    const step = NEXT_STATUS[order.status];
    if (!step) return;
    setBusyId(order._id);
    setError(null);
    try {
      await api.shop.setOrderStatus(order._id, step.next);
      queue.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(order: OrderRow) {
    // Cancelling refunds the wallet and puts the stock back, so it is not a
    // tidy-up action — say so before doing it.
    if (
      !confirm(
        `Cancel this ${money(order.total)} order? The player is refunded and the stock goes back.`
      )
    ) {
      return;
    }
    setBusyId(order._id);
    setError(null);
    try {
      await api.shop.setOrderStatus(order._id, "cancelled");
      queue.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const waiting = orders.filter((o) => o.status === "received").length;

  return (
    <>
      <h1>Order queue</h1>
      <p className="page-sub">
        {orders.length === 0
          ? "Nothing in the queue"
          : `${orders.length} open · ${waiting} not started yet`}
      </p>

      <ErrorNote error={queue.error} />
      <ErrorNote error={error} />

      {queue.loading && !queue.data ? (
        <Loading rows={3} />
      ) : orders.length === 0 ? (
        <Empty>
          The queue is clear. Seat orders from the PC overlay and the player app both land here.
        </Empty>
      ) : (
        <div className="stack">
          {orders.map((order) => {
            const step = NEXT_STATUS[order.status];
            return (
              <div key={order._id} className="card">
                <div className="card__head">
                  <StatusBadge status={order.status} />
                  <span className="small faint">
                    <Elapsed since={order.createdAt} /> ago
                  </span>
                  <div className="card__actions">
                    <strong className="num">{money(order.total)}</strong>
                  </div>
                </div>

                <div className="row row--wrap small" style={{ marginBottom: 10 }}>
                  {/* The seat is what the runner needs; it comes from the
                      player's live session, not from anything they typed. */}
                  <span className="badge" data-tone="busy">
                    seat {order.pcId ? shortId(order.pcId) : "unknown"}
                  </span>
                  <span className="faint mono" title={order.playerId}>
                    player {shortId(order.playerId)}
                  </span>
                  <span className="faint">paid by {order.paymentSource.toLowerCase()}</span>
                </div>

                <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
                  {order.items.map((item, i) => (
                    <li key={i}>
                      <strong>{item.qty}×</strong> {item.name ?? shortId(item.productId)}
                      <span className="faint small"> · {money(item.price * item.qty)}</span>
                    </li>
                  ))}
                </ul>

                <div className="btn-row">
                  {step && (
                    <button
                      className="btn--primary btn--sm"
                      disabled={busyId === order._id}
                      onClick={() => void advance(order)}
                    >
                      {step.label}
                    </button>
                  )}
                  <button
                    className="btn--danger btn--sm"
                    disabled={busyId === order._id}
                    onClick={() => void cancel(order)}
                  >
                    Cancel &amp; refund
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
