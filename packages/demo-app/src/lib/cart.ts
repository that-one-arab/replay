import { PRODUCTS, type Product } from "./products";

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

// --- Persistence -------------------------------------------------------------
// The cart is the thing we most want to survive a reload — without this, a
// refresh (or a capture that reloads the tab) silently empties it, which masks
// real repros. We store only product ids + quantities and a coupon code, then
// rehydrate against the current catalog so price edits and removed products are
// never replayed from stale storage.

export const CART_STORAGE_KEY = "northstar-cart:v1";

export type SavedCartLine = { id: string; quantity: number };
export type SavedCart = {
  version: 1;
  items: SavedCartLine[];
  couponCode: string | null;
};

export type PersistedCartState = { items: CartItem[]; coupon: Coupon | null };

// Reads the saved cart and rehydrates it against the live catalog. Any error,
// shape mismatch, unknown product id, or invalid coupon degrades gracefully to
// an empty cart rather than throwing.
export function loadSavedCart(): PersistedCartState {
  if (typeof localStorage === "undefined") return { items: [], coupon: null };
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return { items: [], coupon: null };
    const saved = JSON.parse(raw) as Partial<SavedCart>;
    if (saved.version !== 1) return { items: [], coupon: null };

    const byId = new Map(PRODUCTS.map((p) => [p.id, p]));
    const items: CartItem[] = [];
    for (const line of saved.items ?? []) {
      if (!line || typeof line.id !== "string") continue;
      const product = byId.get(line.id);
      if (!product || typeof line.quantity !== "number" || line.quantity <= 0) continue;
      items.push({ product, quantity: Math.floor(line.quantity) });
    }
    const coupon = saved.couponCode ? lookupCoupon(saved.couponCode) : null;
    return { items, coupon };
  } catch {
    return { items: [], coupon: null };
  }
}

// Serializes the in-memory cart to localStorage. Fails silently when storage is
// unavailable or over quota — the cart keeps working in memory for the session.
export function saveCartState(state: PersistedCartState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const saved: SavedCart = {
      version: 1,
      items: state.items.map((i) => ({ id: i.product.id, quantity: i.quantity })),
      couponCode: state.coupon?.code ?? null,
    };
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // ignore — degrade to in-memory only
  }
}
