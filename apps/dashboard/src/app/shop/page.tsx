"use client";

import { useState } from "react";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import { Empty, ErrorNote, Loading, money } from "@/components/ui";

/** Products and stock (plan H1, H2). */
export default function ShopPage() {
  const { api, staff } = useSession();
  const stream = useZoneStream(staff?.zoneId);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", price: "", stockQty: "", lowStockThreshold: "5" });

  const products = useLiveData(() => api.shop.products(), {
    revision: stream.revision,
    fallbackMs: 60_000,
  });

  const rows = products.data ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.shop.createProduct({
        name: form.name.trim(),
        price: Number(form.price),
        stockQty: Number(form.stockQty || 0),
        lowStockThreshold: Number(form.lowStockThreshold || 5),
      });
      setForm({ name: "", price: "", stockQty: "", lowStockThreshold: "5" });
      products.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restock(id: string, current: number) {
    const input = window.prompt("New stock count", String(current));
    if (input === null) return;
    const stockQty = Number(input);
    if (!Number.isFinite(stockQty) || stockQty < 0) {
      setError("Stock must be a number of 0 or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.shop.updateProduct(id, { stockQty });
      products.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Shop</h1>
      <p className="page-sub">
        {rows.length} products · {rows.filter((p) => p.stockQty <= p.lowStockThreshold).length} low on stock
      </p>

      <ErrorNote error={products.error} />
      <ErrorNote error={error} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__head">
          <h2 className="card__title">Add a product</h2>
        </div>
        <form onSubmit={create}>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            <div className="field">
              <label htmlFor="p-name">Name</label>
              <input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Cold coffee"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="p-price">Price (₹)</label>
              <input
                id="p-price"
                type="number"
                min="0"
                step="0.5"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="p-stock">Stock</label>
              <input
                id="p-stock"
                type="number"
                min="0"
                value={form.stockQty}
                onChange={(e) => setForm({ ...form, stockQty: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-low">Alert below</label>
              <input
                id="p-low"
                type="number"
                min="0"
                value={form.lowStockThreshold}
                onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
              />
            </div>
          </div>
          <button className="btn--primary" disabled={busy || !form.name.trim() || !form.price}>
            Add product
          </button>
        </form>
      </div>

      <div className="card card--flush">
        {products.loading && !products.data ? (
          <div style={{ padding: 14 }}>
            <Loading rows={3} />
          </div>
        ) : rows.length === 0 ? (
          <Empty>No products yet. Add one above and it appears in the seated-zone shop.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="right">Price</th>
                  <th className="right">Stock</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const low = p.stockQty <= p.lowStockThreshold;
                  return (
                    <tr key={p._id}>
                      <td>
                        {p.name}
                        {!p.active && <span className="faint small"> · inactive</span>}
                      </td>
                      <td className="right num">{money(p.price)}</td>
                      <td className="right num">
                        {low ? (
                          <span className="badge" data-tone="warn">
                            {p.stockQty} low
                          </span>
                        ) : (
                          p.stockQty
                        )}
                      </td>
                      <td className="right">
                        <button className="btn--sm" disabled={busy} onClick={() => void restock(p._id, p.stockQty)}>
                          Set stock
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
