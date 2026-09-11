"use client";

import { useCallback, useEffect, useState } from "react";

import type { LedgerRow } from "@seika/types";

import { usePlayer } from "@/lib/session";
import { Empty, ErrorNote, Loading, dateTime, money } from "@/components/ui";

/**
 * Wallet (plan F5).
 *
 * Every row here is a ledger entry, which is also how the balance is computed —
 * so what a player sees adds up to what they have, by construction. Coins are
 * a separate thing and are never mixed in.
 */
const TOPUP_AMOUNTS = [100, 200, 500, 1000];

const TYPE_LABEL: Record<string, string> = {
  TOPUP: "Top-up",
  DEDUCT: "Session",
  REFUND: "Refund",
  ADJUST: "Adjustment",
  PACKAGE: "Package",
  SHOP: "Shop order",
  BOOKING: "Booking",
  OPENING_BALANCE: "Balance brought over",
};

export default function WalletPage() {
  const { api, passport, playerId, refresh } = usePlayer();
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!playerId) return;
    try {
      setLedger(await api.wallet.ledger(playerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, playerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function topUp(amount: number) {
    if (!passport) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The API returns a gateway order; in mock mode it also lets us complete
      // it, so the flow is testable end to end without real money.
      const order = await api.payments.createOrder({
        amount,
        zoneId: (await currentZoneId(api)) ?? "",
      });

      if (order.mock) {
        await api.payments.simulate(order.orderId);
        setNotice(`Added ${money(amount)} to your wallet.`);
      } else {
        // With real keys the checkout widget takes over here and the wallet is
        // credited by the verified webhook, never by this client.
        setNotice(
          `Order ${order.orderId} created for ${money(amount)}. Complete the payment to top up.`
        );
      }
      await refresh();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Wallet</h1>
      <p className="sub">Real money. Your SEIKA Coins are separate and cannot be cashed out.</p>

      <div className="card">
        <div className="small faint">Balance</div>
        <div style={{ fontSize: 34, fontWeight: 800 }} className="num">
          {money(passport?.wallet.balance)}
        </div>
      </div>

      <ErrorNote error={error} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      <div className="card">
        <h2 className="card__title">Add money</h2>
        <div className="hours" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          {TOPUP_AMOUNTS.map((amount) => (
            <button
              key={amount}
              className="hour"
              style={{ minHeight: 58 }}
              disabled={busy}
              onClick={() => void topUp(amount)}
            >
              <span className="hour__label" style={{ fontSize: 15 }}>
                {money(amount)}
              </span>
            </button>
          ))}
        </div>
        <p className="small faint" style={{ marginBottom: 0 }}>
          You can also pay cash at the counter and the cashier will add it here.
        </p>
      </div>

      <h2>History</h2>
      <div className="card">
        {ledger === null ? (
          <Loading rows={3} />
        ) : ledger.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="list">
            {ledger.map((row) => (
              <div className="item" key={row._id}>
                <div className="item__main">
                  <div className="item__title">{TYPE_LABEL[row.type] ?? row.type}</div>
                  <div className="item__sub">{dateTime(row.createdAt)}</div>
                </div>
                <div className="item__right">
                  <span className={row.amount >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>
                    {row.amount >= 0 ? "+" : "−"}
                    {money(Math.abs(row.amount))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The zone a top-up belongs to. A player's balance is per zone, so a top-up has
 * to name one: their live session's zone if they are seated, otherwise the zone
 * of the last one they played in.
 */
async function currentZoneId(api: ReturnType<typeof usePlayer>["api"]): Promise<string | null> {
  const res = await api.sessions.history({ limit: 5 });
  return res.sessions[0]?.zoneId ?? null;
}
