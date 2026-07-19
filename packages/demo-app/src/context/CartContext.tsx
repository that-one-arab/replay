import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import type { Product } from "../lib/products";
import { type CartItem, type Coupon, lookupCoupon } from "../lib/cart";

type CartState = {
  items: CartItem[];
  coupon: Coupon | null;
};

type CartAction =
  | { type: "add"; product: Product }
  | { type: "remove"; productId: string }
  | { type: "setQuantity"; productId: string; quantity: number }
  | { type: "applyCoupon"; code: string }
  | { type: "clearCoupon" }
  | { type: "clear" };

const initialState: CartState = { items: [], coupon: null };

function reducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "add": {
      const existing = state.items.find((i) => i.product.id === action.product.id);
      if (existing) {
        return {
          ...state,
          items: state.items.map((i) =>
            i.product.id === action.product.id ? { ...i, quantity: i.quantity + 1 } : i,
          ),
        };
      }
      return { ...state, items: [...state.items, { product: action.product, quantity: 1 }] };
    }
    case "remove":
      return { ...state, items: state.items.filter((i) => i.product.id !== action.productId) };
    case "setQuantity": {
      if (action.quantity <= 0) {
        return { ...state, items: state.items.filter((i) => i.product.id !== action.productId) };
      }
      return {
        ...state,
        items: state.items.map((i) =>
          i.product.id === action.productId ? { ...i, quantity: action.quantity } : i,
        ),
      };
    }
    case "applyCoupon": {
      return { ...state, coupon: lookupCoupon(action.code) };
    }
    case "clearCoupon":
      return { ...state, coupon: null };
    case "clear":
      return initialState;
    default:
      return state;
  }
}

type CartContextValue = {
  items: CartItem[];
  coupon: Coupon | null;
  count: number;
  add: (product: Product) => void;
  remove: (productId: string) => void;
  setQuantity: (productId: string, quantity: number) => void;
  applyCoupon: (code: string) => void;
  clearCoupon: () => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const value = useMemo<CartContextValue>(
    () => ({
      items: state.items,
      coupon: state.coupon,
      count: state.items.reduce((sum, i) => sum + i.quantity, 0),
      add: (product) => dispatch({ type: "add", product }),
      remove: (productId) => dispatch({ type: "remove", productId }),
      setQuantity: (productId, quantity) => dispatch({ type: "setQuantity", productId, quantity }),
      applyCoupon: (code) => dispatch({ type: "applyCoupon", code }),
      clearCoupon: () => dispatch({ type: "clearCoupon" }),
      clear: () => dispatch({ type: "clear" }),
    }),
    [state],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within a CartProvider");
  return ctx;
}
