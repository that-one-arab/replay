import { Bolt } from "./icons";

const tech = [
  "GPT-5.6 Terra",
  "rrweb",
  "Playwright",
  "OpenAI Codex",
  "Model Context Protocol",
  "Chrome DevTools Protocol",
  "React",
  "Vite",
];

export function Marquee() {
  return (
    <section className="relative mt-24 border-y border-white/8 py-7">
      <div className="mx-auto max-w-6xl px-6">
        <p className="mb-5 text-center text-xs uppercase tracking-[0.22em] text-white/40">
          One capture stack — engineered with
        </p>
      </div>
      <div className="relative overflow-hidden mask-fade-x">
        <div className="flex w-max animate-marquee gap-4">
          {[...tech, ...tech].map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/70"
            >
              <Bolt className="h-3.5 w-3.5 text-brand-400" />
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
