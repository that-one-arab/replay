import { Reveal, Tag } from "./primitives";
import { TerraCore } from "./TerraCore";
import { Bolt, Cpu, Sparkles } from "./icons";

export function TerraSection() {
  return (
    <section id="terra" className="relative overflow-hidden px-4 py-28 sm:px-6">
      {/* Section-unique ambient wash */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="absolute inset-0 bg-dots opacity-30 mask-fade-b" />
      </div>

      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="flex justify-center">
            <Tag tone="terra" className="text-sm">
              <Bolt className="h-4 w-4" /> The model behind Replay
            </Tag>
          </div>
        </Reveal>

        <div className="mt-12 grid items-center gap-12 lg:grid-cols-2">
          {/* Core */}
          <Reveal>
            <div className="flex justify-center">
              <TerraCore />
            </div>
          </Reveal>

          {/* Story */}
          <div>
            <Reveal>
              <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">
                Forged with{" "}
                <span className="text-gradient-terra">GPT-5.6 Terra.</span>
              </h2>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-white/65 sm:text-lg">
                Replay was built end-to-end at{" "}
                <a
                  href="https://openai.devpost.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-white underline-offset-4 hover:underline"
                >
                  OpenAI Build Week
                </a>{" "}
                with GPT-5.6 Terra in the driver's seat — OpenAI's credits and early
                access made it possible. Terra reasoned through the rrweb capture pipeline,
                designed the atomic marker-action binding, and shaped the reviewer-facing
                timeline you've been watching on this page.
              </p>
            </Reveal>
            <Reveal delay={0.16}>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100">
                  <Cpu className="h-4 w-4" /> OpenAI Build Week · 2026
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-4 py-2 text-sm font-medium text-white/70">
                  <Sparkles className="h-4 w-4 text-cyan-300" /> Built on OpenAI credits
                </span>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
