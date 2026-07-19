import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { OrbitMark, Tag } from "./primitives";
import { Bolt, Github } from "./icons";

const links = [
  { label: "How it works", href: "#how" },
  { label: "The magic", href: "#magic" },
  { label: "Features", href: "#features" },
  { label: "GPT-5.6 Terra", href: "#terra" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
      className="fixed inset-x-0 top-0 z-50 px-4 pt-3 sm:px-6"
    >
      <nav
        className={`mx-auto flex max-w-6xl items-center justify-between rounded-2xl px-4 py-2.5 transition-all duration-500 sm:px-5 ${
          scrolled ? "glass-strong shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)]" : "border border-transparent"
        }`}
      >
        <a href="#top" className="flex items-center gap-2.5">
          <span className="relative grid h-9 w-9 place-items-center">
            <OrbitMark className="h-8 w-8 animate-spin-slower" />
            <span className="absolute inset-0 -z-10 rounded-full bg-brand-500/40 blur-md" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-white">
            Replay
          </span>
          <Tag tone="terra" className="ml-1 hidden sm:inline-flex">
            <Bolt className="h-3.5 w-3.5" /> GPT-5.6 Terra
          </Tag>
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3.5 py-2 text-sm text-white/65 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="hidden h-10 w-10 place-items-center rounded-full text-white/65 transition-colors hover:bg-white/5 hover:text-white sm:grid"
          >
            <Github className="h-5 w-5" />
          </a>
          <a
            href="#get-started"
            className="hidden rounded-full bg-gradient-to-r from-brand-500 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_12px_34px_-12px_var(--color-brand-500)] transition-transform hover:-translate-y-0.5 sm:inline-flex"
          >
            Get the plugin
          </a>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Menu"
            className="grid h-10 w-10 place-items-center rounded-full glass text-white md:hidden"
          >
            <span className="text-lg leading-none">{open ? "✕" : "☰"}</span>
          </button>
        </div>
      </nav>

      {open && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto mt-2 max-w-6xl rounded-2xl glass-strong p-3 md:hidden"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block rounded-xl px-4 py-3 text-sm text-white/75 hover:bg-white/5"
            >
              {l.label}
            </a>
          ))}
          <a
            href="#get-started"
            onClick={() => setOpen(false)}
            className="mt-1 block rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-600 px-4 py-3 text-center text-sm font-semibold text-white"
          >
            Get the plugin
          </a>
        </motion.div>
      )}
    </motion.header>
  );
}
