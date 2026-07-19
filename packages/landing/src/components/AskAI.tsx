import { motion } from "framer-motion";
import { Reveal, Tag } from "./primitives";
import { ArrowRight, Bolt, Check, Compass, Flag, Sparkles } from "./icons";

export function AskAI() {
  return (
    <section className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        {/* Copy */}
        <div>
          <Reveal>
            <Tag tone="terra">
              <Sparkles className="h-3.5 w-3.5" /> Ask AI
            </Tag>
          </Reveal>
          <Reveal delay={0.06}>
            <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
              The replay{" "}
              <span className="text-gradient-terra">explains itself.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/60 sm:text-lg">
              An assistant lives inside the player. It reads the distilled timeline —
              navigations, clicks, typed input, markers, idle gaps — and answers in plain
              language. While it talks, it can <strong className="text-white/90">seek, pause,
              and highlight</strong> the exact elements it's describing.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <ul className="mt-7 space-y-3">
              {[
                "Grounded in the replay's real semantic timeline — not guesswork",
                "Drives the player: seek to a step, highlight a target, grab a screen",
                "Runs locally through your own Codex account; the share host has none",
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-sm text-white/70">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.24}>
            <div className="mt-7 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">
              <Bolt className="h-4 w-4" /> Reasoning powered by GPT-5.6 Terra
              <ArrowRight className="h-4 w-4" />
            </div>
          </Reveal>
        </div>

        {/* Chat mock */}
        <Reveal delay={0.1}>
          <ChatMock />
        </Reveal>
      </div>
    </section>
  );
}

const turns = [
  {
    who: "you",
    text: "Where did the coupon get rejected?",
  },
  {
    who: "ai",
    text: "At step 04 — the agent typed SPRING25, but the store rejected it as expired. I'll jump there.",
    tools: ["seek → 0:14", "highlight #coupon"],
  },
];

function ChatMock() {
  return (
    <div className="relative">
      <div className="absolute -inset-5 -z-10 rounded-[2rem] bg-gradient-to-tr from-emerald-500/15 via-cyan-500/10 to-brand-500/15 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-ink-900/80 shadow-2xl backdrop-blur-md">
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-white/80">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-emerald-400 to-cyan-500 text-ink-950">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            Replay assistant
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> online
          </span>
        </div>

        <div className="space-y-4 p-5">
          {turns.map((t, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 + i * 0.5, duration: 0.5 }}
              className={t.who === "you" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm ${
                  t.who === "you"
                    ? "bg-gradient-to-br from-brand-500 to-fuchsia-600 text-white"
                    : "border border-white/10 bg-white/[0.04] text-white/85"
                }`}
              >
                {t.text}
                {t.tools && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.tools.map((tool) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-200"
                      >
                        <Compass className="h-2.5 w-2.5" /> {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          ))}

          {/* mini replay strip the AI is seeking on */}
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 1.3 }}
            className="rounded-xl border border-white/8 bg-white/[0.02] p-3"
          >
            <div className="mb-2 flex items-center justify-between text-[10px] text-white/40">
              <span className="inline-flex items-center gap-1">
                <Flag className="h-3 w-3 text-brand-300" /> seeked to marker
              </span>
              <span className="font-mono">0:14 / 1:00</span>
            </div>
            <div className="relative h-6 overflow-hidden rounded-md bg-white/5">
              <div className="absolute inset-y-0 left-0 flex w-full gap-0.5">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-full ${[2, 5].includes(i) ? "w-[6%] bg-white/8" : "bg-brand-500/40"}`}
                    style={{ flexGrow: [2, 5].includes(i) ? 0 : 1 }}
                  />
                ))}
              </div>
              <motion.div
                className="absolute inset-y-0 w-[2px] bg-white"
                initial={{ left: "8%" }}
                whileInView={{ left: "23%" }}
                viewport={{ once: true }}
                transition={{ delay: 1.5, duration: 0.8, ease: "easeInOut" }}
              >
                <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-white" />
              </motion.div>
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 2.2 }}
                className="absolute top-1/2 -translate-y-1/2 rounded border border-emerald-400/60 px-1 text-[8px] text-emerald-200"
                style={{ left: "21%" }}
              >
                #coupon
              </motion.span>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
