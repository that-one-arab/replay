import { useCart } from "../context/CartContext";
import { computeTotals, formatMoney } from "../lib/cart";

export function OrderSummary() {
  const { items, coupon } = useCart();
  const totals = computeTotals(items, coupon);
  const discountApplied = totals.discount > 0;

  return (
    <dl className="space-y-2 text-sm">
      <div className="flex justify-between text-stone-600">
        <dt>Subtotal</dt>
        <dd>{formatMoney(totals.subtotal)}</dd>
      </div>
      {coupon?.valid && (
        <div className={`flex justify-between ${discountApplied ? "text-emerald-600" : "text-stone-400"}`}>
          <dt>Discount ({Math.round(coupon.percent * 100)}%)</dt>
          <dd>−{formatMoney(totals.discount)}</dd>
        </div>
      )}
      <div className="flex justify-between border-t border-stone-200 pt-2 text-base font-semibold text-stone-800">
        <dt>Total</dt>
        <dd>{formatMoney(totals.total)}</dd>
      </div>
    </dl>
  );
}
