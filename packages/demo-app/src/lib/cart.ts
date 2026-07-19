import type { Product } from "./products";

export type CartItem = {
  product: Product;
  quantity: number;
};

export type Coupon = {
  code: string;
  percent: number;
  valid: true;
};

export type Totals = {
  subtotal: number;
  discount: number;
  total: number;
};

// Valid coupon codes and their discount fraction.
export const COUPONS: Record<string, number> = {
  SAVE20: 0.2,
  WELCOME10: 0.1,
};

// The bug toggle. With the default (unset), an accepted coupon is announced as
// "applied" but never reaches the total — the classic frontend/state mismatch
// we want to capture on camera. Set VITE_BUG_FIXED=true to demonstrate the fix.
const BUG_FIXED = import.meta.env.VITE_BUG_FIXED === "true";

export const round = (n: number) => Math.round(n * 100) / 100;

export function lookupCoupon(code: string): Coupon | null {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const percent = COUPONS[normalized];
  return percent === undefined ? null : { code: normalized, percent, valid: true };
}

export function computeTotals(items: CartItem[], coupon: Coupon | null): Totals {
  const subtotal = round(items.reduce((sum, i) => sum + i.product.price * i.quantity, 0));
  const discount = coupon ? round(subtotal * coupon.percent) : 0;
  return {
    subtotal,
    // BUG: the discount is accepted and announced as applied, but the displayed
    // total silently keeps the full subtotal unless VITE_BUG_FIXED is set.
    discount: BUG_FIXED ? discount : 0,
    total: BUG_FIXED ? round(subtotal - discount) : subtotal,
  };
}

export const formatMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
