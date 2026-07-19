import { PRODUCTS } from "../lib/products";
import { ProductCard } from "../components/ProductCard";

export function Storefront() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-stone-400">Northstar Goods</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-stone-800">
          Quiet objects for a calmer home.
        </h1>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {PRODUCTS.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
}
