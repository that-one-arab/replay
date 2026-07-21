import { motion } from "framer-motion";
import { HeroReplay } from "./HeroReplay";
import { Button, Tag } from "./primitives";
import { ArrowRight, Bolt, Cpu, Github } from "./icons";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  return (
    <section id="top" className="relative px-4 pt-28 sm:px-6 sm:pt-36">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-8">
        {/* Copy */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="flex flex-wrap items-center gap-2"
          >
            <Tag tone="terra" className="text-[13px]">
              <Bolt className="h-4 w-4" />
              Powered by GPT-5.6 Terra
            </Tag>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.08 }}
            className="mt-6 font-display text-[2.6rem] font-semibold leading-[1.02] tracking-tight text-white sm:text-6xl"
          >
            Watch your agent{" "}
            <span className="text-gradient">reproduce the bug</span>
            <br className="hidden sm:block" /> — then replay it without the{" "}
            <span className="relative whitespace-nowrap">
              <span className="text-gradient">dead air</span>
              <svg
                viewBox="0 0 220 14"
                className="absolute -bottom-2 left-0 h-3 w-full text-fuchsia-500/70"
                preserveAspectRatio="none"
              >
                <path
                  d="M2 9 C 60 2, 160 2, 218 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            .
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.16 }}
            className="mt-6 max-w-xl text-base leading-relaxed text-white/65 sm:text-lg"
          >
            Replay captures the exact browser session your coding agent drives to
            reproduce or verify a change — every click, input, tab, and navigation —
            as a featherweight DOM timeline. Then it <strong className="text-white/90">auto-cuts the
            long pauses</strong> where the agent thinks, and hands back a shareable replay link.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.24 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button href="#get-started" icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}>
              Capture your first replay
            </Button>
            <Button href="https://github.com/that-one-arab/replay" variant="ghost" icon={<Github className="h-4 w-4" />}>
              See how it works
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-white/45"
          >
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="h-4 w-4 text-emerald-300" /> Forged with GPT-5.6 Terra
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> 100% local capture
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> Portable <code className="font-mono text-white/60">.replay</code> artifacts
            </span>
          </motion.div>
        </div>

        {/* Visual */}
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}
          className="relative"
        >
          <HeroReplay />
        </motion.div>
      </div>
    </section>
  );
}
