import { motion } from "framer-motion";
import { Button, Tag } from "./primitives";
import { ArrowRight, Bolt, Github } from "./icons";

export function FinalCTA() {
  return (
    <section id="get-started" className="relative px-4 py-28 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-ink-850 to-ink-925 px-6 py-16 text-center sm:px-16"
        >
          {/* glow accents */}
          <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-brand-600/30 blur-[90px]" />
          <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-fuchsia-600/25 blur-[90px]" />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-64 w-[120%] -translate-x-1/2 -translate-y-1/2 bg-grid opacity-20" />

          <div className="relative">
            <div className="flex justify-center">
              <Tag tone="terra">
                <Bolt className="h-4 w-4" /> Powered by GPT-5.6 Terra
              </Tag>
            </div>

            <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">
              Capture your first{" "}
              <span className="shimmer-text">agent replay.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base text-white/60 sm:text-lg">
              Install the Replay plugin, ask your agent to reproduce a bug, and get a
              shareable replay link — dead air already cut.
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button href="#" icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}>
                Install for Codex
              </Button>
              <Button href="https://github.com/that-one-arab/replay" variant="ghost" icon={<Github className="h-4 w-4" />}>
                Star on GitHub
              </Button>
            </div>

            <p className="mt-6 text-xs text-white/40">
              Built at OpenAI Build Week · macOS (Apple silicon) · Google Chrome required
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
