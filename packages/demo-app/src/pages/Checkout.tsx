import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../context/CartContext";
import { computeTotals, formatMoney } from "../lib/cart";

export function Checkout() {
  const { items, coupon, clear } = useCart();
  const navigate = useNavigate();
  const totals = computeTotals(items, coupon);

  const [form, setForm] = useState({
    name: "",
    email: "",
    address: "",
    city: "",
    zip: "",
    card: "",
  });

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-2xl font-bold text-stone-800">Nothing to check out</h1>
        <Link
          to="/"
          className="mt-6 inline-block rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white hover:bg-stone-900"
        >
          Browse the shop
        </Link>
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clear();
    navigate("/confirmation");
  }

  const field = (key: keyof typeof form, label: string, type = "text") => (
    <label className="block">
      <span className="text-sm font-medium text-stone-600">{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
      />
    </label>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-stone-800">Checkout</h1>
      <form onSubmit={handleSubmit} className="grid gap-10 lg:grid-cols-[1fr_320px]">
        <div className="space-y-8">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wider text-stone-400">Contact</legend>
            {field("name", "Full name")}
            {field("email", "Email", "email")}
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wider text-stone-400">Shipping</legend>
            {field("address", "Street address")}
            <div className="grid grid-cols-2 gap-3">
              {field("city", "City")}
              {field("zip", "ZIP")}
            </div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wider text-stone-400">Payment</legend>
            {field("card", "Card number")}
          </fieldset>
        </div>

        <aside className="h-fit rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-stone-800">Order summary</h2>
          <ul className="mb-4 space-y-2 text-sm text-stone-600">
            {items.map(({ product, quantity }) => (
              <li key={product.id} className="flex justify-between">
                <span>
                  {product.name} × {quantity}
                </span>
                <span>{formatMoney(product.price * quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-2 border-t border-stone-200 pt-3 text-sm">
            <div className="flex justify-between text-stone-600">
              <dt>Subtotal</dt>
              <dd>{formatMoney(totals.subtotal)}</dd>
            </div>
            {coupon?.valid && (
              <div className="flex justify-between text-stone-400">
                <dt>Discount ({Math.round(coupon.percent * 100)}%)</dt>
                <dd>−{formatMoney(totals.discount)}</dd>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold text-stone-800">
              <dt>Total</dt>
              <dd>{formatMoney(totals.total)}</dd>
            </div>
          </dl>
          <button
            type="submit"
            className="mt-6 w-full rounded-lg bg-stone-800 py-3 text-sm font-semibold text-white hover:bg-stone-900"
          >
            Place order
          </button>
        </aside>
      </form>
    </div>
  );
}
