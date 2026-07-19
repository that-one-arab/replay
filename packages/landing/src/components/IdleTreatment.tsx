import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationFrame } from "framer-motion";
import { Reveal, SectionHeading } from "./primitives";
import { Eye, FastForward, Scissors } from "./icons";

type Mode = "cut" | "ff" | "keep";

const MODES: { key: Mode; label: string; icon: typeof Scissors; blurb: string; watch: string; saved: string }[] = [
  { key: "cut", label: "Cut", icon: Scissors, blurb: "Idle gaps are removed entirely. Reviewers see only actions.", watch: "0:09", saved: "−85%" },
  { key: "ff", label: "Fast-forward", icon: FastForward, blurb: "Keep the rhythm, but blur past the thinking at 8×.", watch: "0:14", saved: "−77%" },
  { key: "keep", label: "Keep", icon: Eye, blurb: "The full, faithful timeline — nothing trimmed.", watch: "1:00", saved: "raw" },
];

const RAW = [
  { kind: "action", w: 12 },
  { kind: "idle", w: 22 },
  { kind: "action", w: 10 },
  { kind: "idle", w: 16 },
  { kind: "action", w: 14 },
  { kind: "idle", w: 20 },
  { kind: "action", w: 6 },
] as const;

const DUR: Record<Mode, number> = { cut: 5, ff: 7, keep: 11 };

export function IdleTreatment() {
  const [mode, setMode] = useState<Mode>("cut");
  const raf = useRef(0);
  const lastMode = useRef<Mode>("cut");
  // Playhead position is written straight to the DOM each frame (compositor-
  // friendly transform) so we never re-render React 60×/second just to move it.
  const playheadRef = useRef<HTMLDivElement>(null);

  useAnimationFrame((_timestamp, delta) => {
    raf.current += Math.min(delta, 64) / 1000;
    const tt = (raf.current % DUR[mode]) / DUR[mode];
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${tt * 100}%)`;
  });

  useEffect(() => {
    if (lastMode.current !== mode) {
      lastMode.current = mode;
      raf.current = 0;
    }
  }, [mode]);

  const active = MODES.find((m) => m.key === mode)!;

  return (
    <section id="magic" className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="The magic"
          title={
            <>
              Skip the part where the agent{" "}
              <span className="text-gradient">stares into space.</span>
            </>
          }
          subtitle="Agents pause to think. Replay detects those idle ranges and lets the author pick how the reviewer experiences them — defaults travel inside every replay."
        />

        <div className="mt-14 grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
          {/* Mode picker */}
          <Reveal>
            <div className="space-y-3">
              {MODES.map((m) => {
                const Icon = m.icon;
                const on = m.key === mode;
                return (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    className={`group flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-all duration-300 ${
                      on
                        ? "border-brand-400/40 bg-brand-500/10 shadow-[0_18px_60px_-30px_var(--color-brand-500)]"
                        : "border-white/8 bg-white/[0.02] hover:border-white/15"
                    }`}
                  >
                    <span
                      className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors ${
                        on
                          ? "bg-gradient-to-br from-brand-500 to-fuchsia-600 text-white"
                          : "bg-white/5 text-white/60"
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="flex-1">
                      <span className="flex items-center justify-between">
                        <span className="font-display text-lg font-semibold text-white">{m.label}</span>
                        <span
                          className={`font-mono text-sm ${on ? "text-emerald-300" : "text-white/40"}`}
                        >
                          {m.saved}
                        </span>
                      </span>
                      <span className="mt-1 block text-sm text-white/55">{m.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Reveal>

          {/* Live comparison */}
          <Reveal delay={0.1}>
            <div className="rounded-3xl border border-white/10 bg-ink-900/60 p-6 shadow-2xl backdrop-blur-md">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-widest text-white/40">Replay watch time</p>
                  <div className="mt-1 flex items-baseline gap-2">
                    <AnimatePresence mode="popLayout">
                      <motion.span
                        key={active.watch}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="font-display text-4xl font-semibold text-white"
                      >
                        {active.watch}
                      </motion.span>
                    </AnimatePresence>
                    <span className="text-sm text-white/40 line-through">1:00 raw</span>
                  </div>
                </div>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                  {active.saved} dead air
                </span>
              </div>

              {/* Raw bar */}
              <div className="mt-6">
                <p className="mb-2 text-[11px] uppercase tracking-widest text-white/35">Raw session</p>
                <Track segments={RAW} idleScale={1} dim />
              </div>

              {/* Replay bar */}
              <div className="mt-4">
                <p className="mb-2 text-[11px] uppercase tracking-widest text-brand-200/70">
                  Replay · {active.label}
                </p>
                <div className="relative">
                  <Track
                    segments={RAW}
                    idleScale={mode === "cut" ? 0 : mode === "ff" ? 0.12 : 1}
                    dim={false}
                  />
                  {/* playhead — position written imperatively each frame */}
                  <div ref={playheadRef} className="absolute -top-1 bottom-0 left-0 right-0">
                    <div className="absolute top-0 h-full w-[2px] bg-white">
                      <span className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_10px_2px_rgba(255,255,255,0.8)]" />
                    </div>
                  </div>
                </div>
              </div>

              <p className="mt-5 text-center text-xs text-white/40">
                Switch modes above — the playhead respects each treatment in real time.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Track({
  segments,
  idleScale,
  dim,
}: {
  segments: readonly { kind: string; w: number }[];
  idleScale: number;
  dim: boolean;
}) {
  const total = segments.reduce((s, x) => s + (x.kind === "idle" ? x.w * idleScale : x.w), 0);
  return (
    <div className="flex h-12 gap-[3px]">
      {segments.map((s, i) => {
        const w = s.kind === "idle" ? s.w * idleScale : s.w;
        if (w <= 0.5) return null;
        if (s.kind === "idle") {
          return (
            <motion.div
              key={i}
              layout
              className="grid h-full place-items-center overflow-hidden rounded-[6px] bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.07)_0_6px,transparent_6px_12px)]"
              style={{ flexGrow: w }}
            />
          );
        }
        return (
          <motion.div
            key={i}
            layout
            className={`overflow-hidden rounded-[6px] ${
              dim
                ? "bg-gradient-to-r from-brand-700/50 to-fuchsia-700/40"
                : "bg-gradient-to-r from-brand-500 to-fuchsia-500"
            }`}
            style={{ flexGrow: w }}
          />
        );
      })}
      <span className="sr-only">{total}</span>
    </div>
  );
}
