import { useState } from "react";
import { useCart } from "../context/CartContext";

export function CouponInput() {
  const { coupon, applyCoupon, clearCoupon } = useCart();
  const [code, setCode] = useState("");
  const [attempted, setAttempted] = useState(false);
  const trimmed = code.trim();

  function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    applyCoupon(code);
  }

  function handleRemove() {
    clearCoupon();
    setCode("");
    setAttempted(false);
  }

  if (coupon?.valid) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
        <span className="text-emerald-700">
          ✓ Coupon <b>{coupon.code}</b> applied — {Math.round(coupon.percent * 100)}% off
        </span>
        <button onClick={handleRemove} className="text-emerald-700 underline">
          Remove
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleApply} className="space-y-2">
      <label className="text-sm font-medium text-stone-600">Coupon code</label>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Try SAVE20"
          className="flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal focus:border-stone-400 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white hover:bg-stone-900"
        >
          Apply
        </button>
      </div>
      {attempted && trimmed && !coupon?.valid && (
        <p className="text-xs text-rose-500">That code isn't valid. Try SAVE20 or WELCOME10.</p>
      )}
    </form>
  );
}
