"use client";

import { useCallback, useEffect, useState } from "react";

import type { ProductRow } from "@seika/types";

import { usePlayer } from "@/lib/session";
import { Empty, ErrorNote, Loading, money } from "@/components/ui";

/**
 * The seated-zone shop (plan H3, H5).
 *
 * There is no PC picker and no zone picker, because there is nothing to pick:
 * the order goes to the seat the API already knows the player is in. If they
 * are not seated, the honest answer is that ordering is not available yet —
 * not a form that fails after they have chosen.
 */
export default function ShopPage() {
  const { api, passport, refresh } = usePlayer();
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [seated, setSeated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.shop.products();
      setProducts(list.filter((p) => p.active));
      setSeated(true);
      setError(null);
    } catch (e) {
      // The catalogue endpoint refuses when there is no live session; that is
      // the "you are not seated" case, not a failure to report as an error.
      const message = e instanceof Error ? e.message : String(e);
      if (/session/i.test(message)) {
        setSeated(false);
        setProducts([]);
      } else {
        setError(message);
      }
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = Object.entries(cart).reduce((sum, [id, qty]) => {
    const p = products?.find((x) => x._id === id);
    return sum + (p ? p.price * qty : 0);
  }, 0);
  const itemCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const balance = passport?.wallet.balance ?? 0;

  function change(id: string, delta: number, stock: number) {
    setCart((c) => {
      const next = Math.max(0, Math.min(stock, (c[id] ?? 0) + delta));
      const copy = { ...c };
      if (next === 0) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }

  async function order() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.shop.placeOrder({
        items: Object.entries(cart).map(([productId, qty]) => ({ productId, qty })),
        paymentSource: "WALLET",
      });
      setNotice(`Ordered — ${money(res.total)} charged. It is on its way to your seat.`);
      setCart({});
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
      <h1>Shop</h1>
      <p className="sub">
        {seated === false
          ? "Start a session and the shop for your zone appears here."
          : "Ordered to your seat — no need to say which PC."}
      </p>

      <ErrorNote error={error} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      {seated === false ? (
        <Empty>You are not seated at a PC right now.</Empty>
      ) : products === null ? (
        <Loading rows={4} />
      ) : products.length === 0 ? (
        <Empty>This zone has nothing in the shop yet.</Empty>
      ) : (
        <>
          <div className="card">
            <div className="list">
              {products.map((p) => {
                const qty = cart[p._id] ?? 0;
                const out = p.stockQty <= 0;
                return (
                  <div className="item" key={p._id}>
                    <div className="item__main">
                      <div className="item__title">{p.name}</div>
                      <div className="item__sub">
                        {money(p.price)}
                        {out ? (
                          <span className="neg"> · out of stock</span>
                        ) : p.stockQty <= p.lowStockThreshold ? (
                          <span className="faint"> · {p.stockQty} left</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn--sm"
                        disabled={qty === 0}
                        onClick={() => change(p._id, -1, p.stockQty)}
                        aria-label={`One less ${p.name}`}
                      >
                        −
                      </button>
                      <span className="num" style={{ minWidth: 18, textAlign: "center" }}>
                        {qty}
                      </span>
                      <button
                        className="btn--sm"
                        disabled={out || qty >= p.stockQty}
                        onClick={() => change(p._id, 1, p.stockQty)}
                        aria-label={`One more ${p.name}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {itemCount > 0 && (
            <div className="card">
              <div className="row">
                <span>
                  {itemCount} item{itemCount === 1 ? "" : "s"}
                </span>
                <span className="spacer num" style={{ fontWeight: 700, fontSize: 18 }}>
                  {money(total)}
                </span>
              </div>
              {total > balance && (
                <div className="alert alert--error" style={{ marginTop: 10, marginBottom: 0 }}>
                  Your balance is {money(balance)}. Top up before ordering.
                </div>
              )}
              <button
                className="btn--primary"
                style={{ marginTop: 12 }}
                disabled={busy || total > balance}
                onClick={() => void order()}
              >
                {busy ? "Ordering…" : `Order · ${money(total)}`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
