import { Reveal, SectionHeading } from "./primitives";

const pains = [
  {
    emoji: "🎟️",
    title: "“It works on my machine.”",
    body: "The ticket arrives with steps and a screenshot — but never what your agent actually did in the browser to reproduce it. Reviewers can't see the proof, so they can't trust the fix.",
  },
  {
    emoji: "🎥",
    title: "Proving the fix is manual.",
    body: "You finished the work. Now you have to record yourself walking through the fix just to prove it's resolved — a journey you already lived once.",
  },
  {
    emoji: "🥱",
    title: "Raw recordings are 90% dead air.",
    body: "Agents pause for long stretches to think between actions. Nobody wants to sit through minutes of a frozen screen to find the 4 seconds that matter.",
  },
];

export function Problem() {
  return (
    <section className="relative px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="The problem"
          title={
            <>
              A bug report without a replay is{" "}
              <span className="text-gradient">just a sad story.</span>
            </>
          }
          subtitle="Replay exists because the evidence behind an agent's work has never been easy to capture — or to actually watch."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {pains.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.1}>
              <div className="group relative h-full overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02] p-7 transition-colors hover:border-white/15">
                <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-fuchsia-600/10 blur-2xl transition-opacity group-hover:opacity-100 opacity-60" />
                <div className="text-3xl">{p.emoji}</div>
                <h3 className="mt-4 font-display text-xl font-semibold text-white">{p.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-white/55">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
