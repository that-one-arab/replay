import { motion } from "framer-motion";

/** Fixed, full-viewport ambient background: aurora glow, grid, drifting motes. */
export function Background() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-950">
      {/* Aurora blobs */}
      <div className="absolute inset-0">
        <div className="absolute -left-[10%] -top-[12%] h-[42rem] w-[42rem] animate-aurora rounded-full bg-brand-600/30 blur-[120px]" />
        <div className="absolute right-[-12%] top-[6%] h-[38rem] w-[38rem] animate-aurora-slow rounded-full bg-fuchsia-600/25 blur-[130px]" />
        <div className="absolute bottom-[-18%] left-[28%] h-[40rem] w-[40rem] animate-aurora rounded-full bg-cyan-500/18 blur-[140px]" />
      </div>

      {/* Grid with radial fade */}
      <div className="absolute inset-0 bg-grid mask-fade-b opacity-[0.5]" />

      {/* Top sheen */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/60 to-transparent" />

      {/* Drifting motes */}
      <Motes />

      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_-10%,transparent_40%,var(--color-ink-950)_100%)]" />
    </div>
  );
}

function Motes() {
  const motes = [
    { x: "8%", y: "22%", s: 3, d: 0, c: "bg-brand-300" },
    { x: "82%", y: "16%", s: 2, d: 1.4, c: "bg-fuchsia-300" },
    { x: "68%", y: "62%", s: 4, d: 0.8, c: "bg-cyan-300" },
    { x: "24%", y: "70%", s: 2, d: 2.1, c: "bg-brand-200" },
    { x: "46%", y: "34%", s: 3, d: 1.1, c: "bg-white" },
    { x: "92%", y: "78%", s: 2, d: 0.4, c: "bg-emerald-300" },
    { x: "14%", y: "50%", s: 2, d: 1.8, c: "bg-fuchsia-200" },
    { x: "58%", y: "84%", s: 3, d: 2.6, c: "bg-brand-300" },
  ];
  return (
    <div className="absolute inset-0">
      {motes.map((m, i) => (
        <motion.span
          key={i}
          className={`absolute rounded-full ${m.c} shadow-[0_0_12px_2px_currentColor]`}
          style={{ left: m.x, top: m.y, width: m.s, height: m.s, color: "transparent" }}
          animate={{ y: [0, -26, 0], opacity: [0.25, 0.9, 0.25] }}
          transition={{ duration: 6 + i, repeat: Infinity, ease: "easeInOut", delay: m.d }}
        />
      ))}
    </div>
  );
}
