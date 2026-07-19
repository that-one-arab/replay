import { OrbitMark } from "./primitives";
import { Bolt, Github } from "./icons";

const cols = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how" },
      { label: "The magic", href: "#magic" },
      { label: "Features", href: "#features" },
      { label: "Get started", href: "#get-started" },
    ],
  },
  {
    title: "Built with",
    links: [
      { label: "GPT-5.6 Terra", href: "#terra" },
      { label: "OpenAI Build Week", href: "https://openai.devpost.com/" },
      { label: "rrweb", href: "#" },
      { label: "Playwright", href: "#" },
    ],
  },
  {
    title: "Engineering",
    links: [
      { label: "Architecture", href: "#" },
      { label: "Replay format", href: "#" },
      { label: "MCP tools", href: "#" },
      { label: "Changelog", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/8 px-4 pb-10 pt-16 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <a href="#top" className="flex items-center gap-2.5">
              <OrbitMark className="h-7 w-7" />
              <span className="font-display text-lg font-semibold text-white">Replay</span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/50">
              Local, DOM-based browser session replay for agent-driven sessions. Capture what
              your coding agent did — share the proof.
            </p>
            <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-medium text-emerald-100">
              <Bolt className="h-3.5 w-3.5" /> Built with GPT-5.6 Terra
            </span>
          </div>

          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                {c.title}
              </h4>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => {
                  const external = l.href.startsWith("http");
                  return (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        target={external ? "_blank" : undefined}
                        rel={external ? "noreferrer" : undefined}
                        className="text-sm text-white/60 transition-colors hover:text-white"
                      >
                        {l.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/8 pt-6 sm:flex-row">
          <p className="text-xs text-white/40">
            © {new Date().getFullYear()} Replay · Forged with{" "}
            <span className="text-emerald-300">GPT-5.6 Terra</span> at OpenAI Build Week.
          </p>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-white/55 transition-colors hover:text-white"
            >
              <Github className="h-4.5 w-4.5" />
            </a>
            <a
              href="#top"
              className="rounded-full border border-white/10 px-4 py-2 text-xs text-white/55 transition-colors hover:text-white"
            >
              Back to top ↑
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
