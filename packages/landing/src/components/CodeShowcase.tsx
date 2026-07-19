import { motion } from "framer-motion";
import { Reveal, SectionHeading } from "./primitives";
import { ArrowRight, Check, Link, Sparkles, Terminal } from "./icons";

const lines = [
  { p: "$", c: "replay browser start", out: "managed chrome ready · cdp on 127.0.0.1:7717" },
  { p: "$", c: "replay start --title \"Checkout repro\"", out: "capturing… session replay_8f3a" },
  { p: "$", c: "replay marker \"Submitting checkout\"", out: "marker bound to last action" },
  { p: "$", c: "replay stop --outcome reproduced", out: "finalized · dead air cut (−82%)" },
];

export function CodeShowcase() {
  return (
    <section className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="Dead simple"
          title={
            <>
              Ask normally. The agent does the{" "}
              <span className="text-gradient">rest.</span>
            </>
          }
          subtitle="You don't learn a replay workflow. You just ask your coding agent to reproduce or verify — capture, markers, and the link happen automatically."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          {/* Prompt card */}
          <Reveal>
            <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <div className="flex items-center gap-2 text-sm text-white/70">
                <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-emerald-400 to-cyan-500 text-ink-950">
                  <Sparkles className="h-4 w-4" />
                </span>
                Your prompt to the agent
              </div>
              <div className="mt-4 flex-1 rounded-xl border border-white/10 bg-ink-950/60 p-5 font-mono text-sm leading-relaxed text-white/80">
                <span className="text-emerald-300">{"// reproduce"}</span>
                <br />
                Read <span className="text-brand-200">BUG_TICKET.md</span>, reproduce the issue,
                and capture a replay.
              </div>
              <div className="mt-4 rounded-xl border border-white/10 bg-ink-950/60 p-5 font-mono text-sm leading-relaxed text-white/80">
                <span className="text-cyan-300">{"// verify a fix"}</span>
                <br />
                Fix the issue, verify it in the browser, and capture a replay of the verified result.
              </div>
              <div className="mt-5 flex items-center gap-2 text-xs text-white/45">
                <Check className="h-4 w-4 text-emerald-400" />
                The agent drives Replay's own browser_* tools — capture is automatic.
              </div>
            </div>
          </Reveal>

          {/* Terminal */}
          <Reveal delay={0.1}>
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-ink-950/80 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <Terminal className="h-4 w-4" /> replay — zsh
                </div>
                <div className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
                </div>
              </div>
              <div className="space-y-3 p-5 font-mono text-[13px]">
                {lines.map((l, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2 + i * 0.25, duration: 0.4 }}
                  >
                    <div className="flex gap-2">
                      <span className="text-emerald-400">{l.p}</span>
                      <span className="text-white/85">{l.c}</span>
                    </div>
                    <div className="pl-4 text-white/40">↳ {l.out}</div>
                  </motion.div>
                ))}
                {/* Resulting link */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 1.3, duration: 0.5 }}
                  className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2.5"
                >
                  <Link className="h-4 w-4 shrink-0 text-emerald-300" />
                  <span className="truncate text-emerald-100">
                    https://replay.sh/r/8f3a-coupon-repro
                  </span>
                  <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-emerald-300" />
                </motion.div>
                <div className="flex gap-2 pt-1">
                  <span className="text-emerald-400">▲</span>
                  <span className="inline-block h-4 w-2 animate-blink bg-brand-300" />
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
