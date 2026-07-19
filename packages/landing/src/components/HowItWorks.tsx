import { motion } from "framer-motion";
import { Reveal, SectionHeading } from "./primitives";
import { Compass, Flag, Link, Play, Scissors } from "./icons";

const steps = [
  {
    n: "01",
    icon: Compass,
    title: "The agent drives the browser",
    body: "Your coding agent reproduces the bug or verifies the fix with normal Playwright browser actions. Replay observes the same managed Chrome over CDP — it never proxies or breaks the agent's workflow.",
    chips: ["browser_navigate", "browser_click", "browser_type"],
  },
  {
    n: "02",
    icon: Flag,
    title: "Replay captures the journey",
    body: "Every DOM event, tab switch, and navigation is recorded as a featherweight timeline. The agent drops atomic markers right on the actions that matter — “Submitting checkout”, “Verified ✓” — bound at capture time.",
    chips: ["capture_start", "replay_marker", "capture_stop"],
  },
  {
    n: "03",
    icon: Link,
    title: "Get a link — dead air removed",
    body: "Stopping finalizes a portable .replay artifact and hands back a replay URL. Idle gaps where the agent thought are auto-cut, so reviewers watch the 4 seconds that matter, not the 4 minutes of nothing.",
    chips: ["shareable URL", ".replay file", "idle: cut"],
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="How it works"
          title={
            <>
              From agent action to{" "}
              <span className="text-gradient">shareable proof</span> in one command.
            </>
          }
          subtitle="Ask normally. The agent does the rest — Replay is invisible until you need the link."
        />

        <div className="relative mt-16">
          {/* connecting line */}
          <div className="absolute left-0 right-0 top-[3.25rem] hidden h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent md:block" />

          <div className="grid gap-6 md:grid-cols-3">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <Reveal key={s.n} delay={i * 0.12}>
                  <div className="relative h-full">
                    <div className="relative z-10 mx-auto grid h-[3.25rem] w-[3.25rem] place-items-center rounded-2xl border border-white/10 bg-ink-900 shadow-glow">
                      <Icon className="h-6 w-6 text-brand-200" />
                      <span className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-600 font-mono text-[10px] font-bold text-white">
                        {s.n}
                      </span>
                    </div>
                    <div className="mt-6 rounded-2xl border border-white/8 bg-white/[0.02] p-6 text-center">
                      <h3 className="font-display text-lg font-semibold text-white">{s.title}</h3>
                      <p className="mt-2.5 text-sm leading-relaxed text-white/55">{s.body}</p>
                      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                        {s.chips.map((c) => (
                          <code
                            key={c}
                            className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-brand-100/90"
                          >
                            {c}
                          </code>
                        ))}
                      </div>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>

        {/* mini flow callout */}
        <Reveal delay={0.1}>
          <div className="mx-auto mt-12 flex max-w-2xl flex-wrap items-center justify-center gap-3 rounded-2xl glass px-6 py-4 text-sm text-white/60">
            <span className="inline-flex items-center gap-2">
              <Play className="h-4 w-4 text-brand-300" /> agent reproduces
            </span>
            <Arrow />
            <span className="inline-flex items-center gap-2">
              <Flag className="h-4 w-4 text-brand-300" /> capture + mark
            </span>
            <Arrow />
            <span className="inline-flex items-center gap-2">
              <Scissors className="h-4 w-4 text-emerald-300" /> cut dead air
            </span>
            <Arrow />
            <span className="inline-flex items-center gap-2">
              <Link className="h-4 w-4 text-cyan-300" /> share link
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Arrow() {
  return (
    <motion.span
      animate={{ x: [0, 4, 0] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      className="text-white/30"
    >
      →
    </motion.span>
  );
}
