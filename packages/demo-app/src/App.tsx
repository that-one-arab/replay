import { NavLink, Route, Routes, Link } from "react-router-dom";
import { useCart } from "./context/CartContext";
import { Storefront } from "./pages/Storefront";
import { Cart } from "./pages/Cart";
import { Checkout } from "./pages/Checkout";
import { Confirmation } from "./pages/Confirmation";

function Header() {
  const { count } = useCart();
  return (
    <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-stone-800 text-white">★</span>
          <span className="text-lg font-bold tracking-tight text-stone-800">Northstar Goods</span>
        </Link>
        <NavLink
          to="/cart"
          className={({ isActive }) =>
            `relative rounded-lg px-3 py-2 text-sm font-medium hover:bg-stone-100 ${
              isActive ? "text-stone-900" : "text-stone-600"
            }`
          }
        >
          Cart
          {count > 0 && (
            <span className="ml-1.5 inline-grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-stone-800 px-1 text-xs font-semibold text-white">
              {count}
            </span>
          )}
        </NavLink>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <Header />
      <Routes>
        <Route path="/" element={<Storefront />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/confirmation" element={<Confirmation />} />
      </Routes>
    </div>
  );
}
