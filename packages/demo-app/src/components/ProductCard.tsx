import type { Product } from "../lib/products";
import { formatMoney } from "../lib/cart";
import { useCart } from "../context/CartContext";

export function ProductCard({ product }: { product: Product }) {
  const { add } = useCart();
  return (
    <div className="flex flex-col rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="grid h-32 place-items-center rounded-xl bg-stone-100 text-5xl">
        {product.emoji}
      </div>
      <div className="mt-3 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
          {product.category}
        </div>
        <h3 className="text-base font-semibold text-stone-800">{product.name}</h3>
        <p className="text-sm text-stone-500">{product.blurb}</p>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-lg font-semibold text-stone-800">{formatMoney(product.price)}</span>
        <button
          onClick={() => add(product)}
          className="rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white transition hover:bg-stone-900"
        >
          Add to cart
        </button>
      </div>
    </div>
  );
}
