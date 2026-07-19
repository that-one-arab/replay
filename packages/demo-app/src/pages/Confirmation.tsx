import { Link } from "react-router-dom";

export function Confirmation() {
  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-center">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-100 text-3xl">
        ✓
      </div>
      <h1 className="mt-6 text-3xl font-bold tracking-tight text-stone-800">Order confirmed</h1>
      <p className="mt-3 text-stone-500">
        Thanks for your order. A confirmation is on its way to your inbox.
      </p>
      <Link
        to="/"
        className="mt-8 inline-block rounded-lg bg-stone-800 px-5 py-3 text-sm font-semibold text-white hover:bg-stone-900"
      >
        Back to the shop
      </Link>
    </div>
  );
}
