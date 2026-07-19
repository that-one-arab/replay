import { Reveal, SectionHeading } from "./primitives";
import { Box, Code, Flag, Layers, Link, Lock, Scissors, Sparkles } from "./icons";

const features = [
  {
    icon: Code,
    title: "DOM-based, not video",
    body: "Replays are reconstructed from captured DOM events — featherweight, pixel-faithful, and inspectable. No giant screen recordings.",
    accent: "from-brand-500/20 to-fuchsia-500/10",
  },
  {
    icon: Scissors,
    title: "Dead air, auto-cut",
    body: "Idle ranges where the agent thinks are detected and trimmed, fast-forwarded, or kept — your call, baked into every replay.",
    accent: "from-emerald-500/20 to-cyan-500/10",
  },
  {
    icon: Flag,
    title: "Narrative markers",
    body: "The agent labels the moments that matter, bound atomically to the action itself — “Submitting checkout”, “Verified ✓”.",
    accent: "from-fuchsia-500/20 to-brand-500/10",
  },
  {
    icon: Box,
    title: "Portable .replay artifacts",
    body: "Every replay exports as a checksummed, gzip-compressed .replay file you can move machine to machine and import verbatim.",
    accent: "from-cyan-500/20 to-brand-500/10",
  },
  {
    icon: Link,
    title: "One shareable link",
    body: "Publish a finalized replay to a hosted player and hand back a single link. Reviewers don't install a thing.",
    accent: "from-brand-500/20 to-cyan-500/10",
  },
  {
    icon: Layers,
    title: "Tabs & navigation, modeled",
    body: "A real browser session, not one DOM tree — focus changes, opened and closed tabs, and reloads all land on one shared timeline.",
    accent: "from-fuchsia-500/20 to-emerald-500/10",
  },
  {
    icon: Sparkles,
    title: "Ask AI about the replay",
    body: "An in-player assistant reads the timeline and can seek, pause, and highlight elements while it explains what happened.",
    accent: "from-emerald-500/20 to-fuchsia-500/10",
  },
  {
    icon: Lock,
    title: "Local-first & private",
    body: "Capture runs entirely on your machine. Passwords are masked, and the only network hop is the optional upload you choose.",
    accent: "from-brand-500/20 to-emerald-500/10",
  },
];

export function Features() {
  return (
    <section id="features" className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="What you get"
          title={
            <>
              Everything a reviewer needs.{" "}
              <span className="text-gradient">Nothing they don't.</span>
            </>
          }
          subtitle="A replay is a complete, faithful, and watchable record of an agent's browser work — small enough to share."
        />

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.title} delay={(i % 4) * 0.07}>
                <div className="group relative h-full overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02] p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/18">
                  <div
                    className={`absolute inset-0 -z-10 bg-gradient-to-br ${f.accent} opacity-0 transition-opacity duration-300 group-hover:opacity-100`}
                  />
                  <span className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5 text-brand-200 transition-transform duration-300 group-hover:scale-110">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-base font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">{f.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
