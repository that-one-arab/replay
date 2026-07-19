import { useEffect, useRef, useState } from "react";
import { motion, useAnimationFrame } from "framer-motion";
import { Cursor, Flag, Play, Scissors } from "./icons";

/* A scripted timeline of the agent's browser journey. Weights are relative
 * widths on the track. Idle segments are the "dead air" Replay cuts. */
type Seg = {
  kind: "action" | "idle";
  weight: number;
  label?: string;
  cursor?: { x: number; y: number };
  marker?: string;
};

const SEGS: Seg[] = [
  { kind: "action", weight: 13, label: "Navigate to store", cursor: { x: 34, y: 40 } },
  { kind: "idle", weight: 7 },
  { kind: "action", weight: 12, label: "Add to cart", cursor: { x: 70, y: 56 } },
  { kind: "action", weight: 10, label: "Apply coupon", cursor: { x: 38, y: 74 }, marker: "Coupon applied" },
  { kind: "idle", weight: 7 },
  { kind: "action", weight: 14, label: "Submit checkout", cursor: { x: 76, y: 34 }, marker: "Submitting checkout" },
  { kind: "action", weight: 9, label: "Verified", cursor: { x: 50, y: 50 }, marker: "Verified ✓" },
];

const TOTAL = SEGS.reduce((s, x) => s + x.weight, 0);

type Layout = { start: number; end: number; seg: Seg }[];
const layout: Layout = SEGS.reduce<Layout>((acc, seg) => {
  const start = acc.length ? acc[acc.length - 1].end : 0;
  acc.push({ start, end: start + seg.weight / TOTAL, seg });
  return acc;
}, []);

const DURATION = 11; // seconds per loop
// The cursor glides ~900ms into each action segment; fire the click just as it lands.
const CLICK_DELAY_MS = 820;

function segIndexAt(t: number): number {
  const i = layout.findIndex((l) => t >= l.start && t < l.end);
  return i === -1 ? layout.length - 1 : i;
}

export function HeroReplay() {
  // Continuous progress lives in a ref and is written straight to the DOM in
  // the RAF loop (compositor-friendly transform). We only setState when the
  // active *segment* changes, so React re-renders a few times per loop instead
  // of ~60×/second — that was the main source of frame drops.
  const tRef = useRef(0);
  const segRef = useRef(-1);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const [activeSeg, setActiveSeg] = useState(0);
  const [clicks, setClicks] = useState<{ id: number; x: number; y: number }[]>([]);
  const idRef = useRef(0);

  useAnimationFrame((_timestamp, delta) => {
    tRef.current += Math.min(delta, 64) / 1000;
    const t = (tRef.current % DURATION) / DURATION;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * 100}%)`;
    if (timeRef.current) timeRef.current.textContent = fmt(t * DURATION);
    const idx = segIndexAt(t);
    if (idx !== segRef.current) {
      segRef.current = idx;
      setActiveSeg(idx);
    }
  });

  const seg = layout[activeSeg].seg;
  const inIdle = seg.kind === "idle";
  const cursor = seg.cursor ?? { x: 50, y: 50 };

  // Fire a click ripple once the cursor has glided to the action's target —
  // the click lands *after* the move, not simultaneously with it.
  useEffect(() => {
    const s = layout[activeSeg].seg;
    if (s.kind !== "action" || !s.cursor) return;
    const spawn = setTimeout(() => {
      const id = ++idRef.current;
      setClicks((c) => [...c, { id, x: s.cursor!.x, y: s.cursor!.y }]);
      setTimeout(() => setClicks((c) => c.filter((k) => k.id !== id)), 900);
    }, CLICK_DELAY_MS);
    return () => clearTimeout(spawn);
  }, [activeSeg]);

  return (
    <div className="relative">
      {/* Glow under the window */}
      <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-tr from-brand-600/30 via-fuchsia-600/20 to-cyan-500/20 blur-2xl" />

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-ink-900/80 shadow-2xl backdrop-blur-md">
        {/* Browser chrome */}
        <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="flex flex-1 items-center gap-2 rounded-md bg-white/5 px-3 py-1.5 font-mono text-[11px] text-white/45">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-400/70" />
            replay://session/replay_8f3a…/play
          </div>
          <span className="hidden items-center gap-1.5 rounded-full border border-fuchsia-400/30 bg-fuchsia-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-200 sm:inline-flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-400" /> Capturing
          </span>
        </div>

        {/* Faux app viewport */}
        <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-ink-850 to-ink-925">
          <FauxApp />

          {/* Click ripples */}
          {clicks.map((c) => (
            <motion.span
              key={c.id}
              initial={{ scale: 0.2, opacity: 0.7 }}
              animate={{ scale: 2.6, opacity: 0 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="pointer-events-none absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-300"
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
            />
          ))}

          {/* Cursor */}
          <motion.div
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-0"
            animate={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
            transition={{ duration: inIdle ? 0.2 : 0.9, ease: [0.16, 1, 0.3, 1] }}
          >
            <Cursor className="h-6 w-6 drop-shadow-[0_4px_10px_rgba(114,92,242,0.7)]" />
            {inIdle && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute left-6 top-5 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/10 bg-ink-950/90 px-2 py-1 text-[10px] text-white/70"
              >
                <span className="h-2.5 w-2.5 animate-spin rounded-full border border-brand-300 border-t-transparent" />
                agent thinking…
              </motion.div>
            )}
          </motion.div>

          {/* Idle dim overlay */}
          <motion.div
            className="pointer-events-none absolute inset-0 bg-ink-950/30 backdrop-grayscale"
            animate={{ opacity: inIdle ? 1 : 0 }}
            transition={{ duration: 0.4 }}
          />
        </div>

        {/* Markers row */}
        <div className="relative h-8 border-b border-white/8">
          {layout.map((l, i) => {
            if (!l.seg.marker) return null;
            const mid = (l.start + l.end) / 2;
            const isActive = i === activeSeg;
            return (
              <div
                key={i}
                className="absolute top-1 -translate-x-1/2"
                style={{ left: `${mid * 100}%` }}
              >
                <motion.div
                  animate={{
                    opacity: isActive ? 1 : 0.55,
                    y: isActive ? 0 : 4,
                  }}
                  className="flex items-center gap-1 whitespace-nowrap rounded-full border border-brand-400/30 bg-ink-950/80 px-2 py-0.5 text-[9.5px] font-medium text-brand-100"
                >
                  <Flag className="h-2.5 w-2.5" />
                  {l.seg.marker}
                </motion.div>
                <div
                  className={`mx-auto h-2 w-px ${isActive ? "bg-brand-300" : "bg-white/20"}`}
                />
              </div>
            );
          })}
        </div>

        {/* Timeline track */}
        <div className="px-4 pb-4 pt-3">
          <div className="relative h-9 overflow-hidden rounded-lg border border-white/8 bg-white/[0.03]">
            <div className="flex h-full w-full gap-[2px] p-[3px]">
              {layout.map((l, i) => {
                const isActive = i === activeSeg;
                if (l.seg.kind === "idle") {
                  return (
                    <div
                      key={i}
                      className="flex h-full items-center justify-center overflow-hidden rounded-[5px] bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.06)_0_6px,transparent_6px_12px)]"
                      style={{ flexGrow: l.seg.weight }}
                    >
                      <Scissors className="h-3 w-3 text-white/25" />
                    </div>
                  );
                }
                return (
                  <motion.div
                    key={i}
                    className={`relative h-full overflow-hidden rounded-[5px] ${
                      isActive
                        ? "bg-gradient-to-r from-brand-500 to-fuchsia-500"
                        : "bg-gradient-to-r from-brand-700/70 to-fuchsia-700/60"
                    }`}
                    style={{ flexGrow: l.seg.weight }}
                  >
                    <span className="absolute inset-0 grid place-items-center truncate px-1.5 text-[9px] font-medium text-white/80">
                      {l.seg.label}
                    </span>
                  </motion.div>
                );
              })}
            </div>

            {/* Playhead — position written imperatively each frame (no React re-render) */}
            <div ref={playheadRef} className="absolute inset-0 z-10">
              <div className="absolute top-0 h-full w-[2px] bg-white">
                <span className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow-[0_0_12px_3px_rgba(255,255,255,0.8)]" />
                <span className="absolute -bottom-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow-[0_0_12px_3px_rgba(255,255,255,0.8)]" />
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-white/55">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-white/5">
                <Play className="h-3.5 w-3.5 text-brand-200" />
              </span>
              <span className="font-mono text-[11px]">
                <span ref={timeRef}>0:00</span> / {fmt(DURATION)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {["1×", "2×", "4×"].map((s, i) => (
                <span
                  key={s}
                  className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                    i === 1 ? "bg-brand-500/25 text-brand-100" : "text-white/40"
                  }`}
                >
                  {s}
                </span>
              ))}
              <span className="ml-1 inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-200">
                <Scissors className="h-3 w-3" /> idle: cut
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/* A tiny faux storefront for the captured viewport. */
function FauxApp() {
  return (
    <div className="absolute inset-0 p-4">
      <div className="flex items-center justify-between">
        <div className="h-2.5 w-20 rounded-full bg-white/15" />
        <div className="flex gap-1.5">
          <div className="h-2 w-8 rounded-full bg-white/10" />
          <div className="h-2 w-8 rounded-full bg-white/10" />
          <div className="h-5 w-12 rounded-md bg-brand-500/40" />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-white/8 bg-white/[0.03] p-2">
            <div className="h-10 rounded-md bg-gradient-to-br from-brand-500/30 to-fuchsia-500/20" />
            <div className="mt-1.5 h-1.5 w-3/4 rounded-full bg-white/15" />
            <div className="mt-1 h-1.5 w-1/2 rounded-full bg-white/8" />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="h-5 flex-1 rounded-md border border-dashed border-white/12 bg-white/[0.02]" />
        <div className="h-5 w-14 rounded-md bg-emerald-500/30" />
      </div>
    </div>
  );
}
