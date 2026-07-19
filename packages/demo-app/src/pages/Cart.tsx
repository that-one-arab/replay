import { Link } from "react-router-dom";
import { useCart } from "../context/CartContext";
import { formatMoney } from "../lib/cart";
import { QuantityStepper } from "../components/QuantityStepper";
import { CouponInput } from "../components/CouponInput";
import { OrderSummary } from "../components/OrderSummary";

export function Cart() {
  const { items, remove, setQuantity } = useCart();

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-2xl font-bold text-stone-800">Your cart is empty</h1>
        <p className="mt-2 text-stone-500">Add something lovely from the shop.</p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white hover:bg-stone-900"
        >
          Browse the shop
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-stone-800">Your cart</h1>
      <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
        <ul className="divide-y divide-stone-200">
          {items.map(({ product, quantity }) => (
            <li key={product.id} className="flex items-center gap-4 py-4">
              <div className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-stone-100 text-3xl">
                {product.emoji}
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-stone-800">{product.name}</h3>
                <p className="text-sm text-stone-500">{formatMoney(product.price)} each</p>
              </div>
              <QuantityStepper
                quantity={quantity}
                onDecrement={() => setQuantity(product.id, quantity - 1)}
                onIncrement={() => setQuantity(product.id, quantity + 1)}
              />
              <span className="w-20 text-right font-medium text-stone-800">
                {formatMoney(product.price * quantity)}
              </span>
              <button
                onClick={() => remove(product.id)}
                aria-label={`Remove ${product.name}`}
                className="text-stone-300 hover:text-rose-500"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        <aside className="h-fit rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-stone-800">Order summary</h2>
          <div className="mb-4">
            <CouponInput />
          </div>
          <OrderSummary />
          <Link
            to="/checkout"
            className="mt-6 block rounded-lg bg-stone-800 py-3 text-center text-sm font-semibold text-white hover:bg-stone-900"
          >
            Proceed to checkout
          </Link>
          <Link
            to="/"
            className="mt-3 block text-center text-sm text-stone-500 hover:text-stone-700"
          >
            Continue shopping
          </Link>
        </aside>
      </div>
    </div>
  );
}
