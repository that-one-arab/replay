# Replay

Replay lets a coding agent capture the browser session it uses to reproduce or
verify a change, then hand back a summarized, annotated, shareable replay link and a portable
`.replay` artifact. The agent drives the browser and captures through one Replay
server — you never start Chrome, pick a port, or describe the capture workflow.

## Install

Replay ships as one ready-to-run package: the Replay runtime and its MCP tools,
with the stock Playwright browser tools embedded. You don't clone this repo,
wire MCP paths by hand, or run a separate Playwright server. **Google Chrome is
required** (the managed browser Replay drives).

### Codex (zero config)

Install **Replay browser replays** from the approved Codex marketplace, then
open a new Codex task. On first use the plugin downloads the verified runtime
into `~/.replay` and starts it automatically.

### Any MCP-capable agent (Claude Code, and others)

Replay is just an MCP server and bundles its own Node runtime, so you do **not**
need Node.js installed. One command fetches the pinned runtime into `~/.replay`
(macOS Apple Silicon only):

```sh
curl -fsSL https://raw.githubusercontent.com/that-one-arab/replay/main/install.sh | sh
```

For **Claude Code**, the installer installs the replay skill into your skills
directory (`$CLAUDE_CONFIG_DIR/skills/replay-browser-capture`, defaulting to
`~/.claude` — set `CLAUDE_CONFIG_DIR` if you use a custom home such as
`~/.claude-signit`) and registers the Replay MCP server at user scope,
automatically, when the `claude` CLI is on your `PATH`. If it isn't, the
installer prints the exact commands to run instead. Open a new Claude Code
session and invoke the skill with `/replay-browser-capture`. The `current`
symlink tracks the latest installed version, so the registration survives
upgrades.

For **Codex** or other agents, the installer prints the snippet to add Replay to
your agent for you to copy and run.

To pin a version, set `REPLAY_VERSION` (e.g. `REPLAY_VERSION=0.2.3`) before
running the installer; set `REPLAY_HOME` to install elsewhere.

## Quickstart

Start the app under test, open an agent task in that app's project, and ask
normally:

> Read BUG_TICKET.md, reproduce the issue, and capture a replay.

For a fix:

> Fix the issue, verify it in the browser, and capture a replay of the verified result.

Your agent drives the browser and captures through the one Replay server,
labelling milestones with atomic `replay_marker` checkpoints on the actions
themselves. When finished it returns a local replay URL and a portable
`.replay` artifact path. With `REPLAY_SHARE_URL` configured, `capture_stop`
also publishes the artifact and returns a share link.

### Try it on the live demo

No project of your own? There's a live demo storefront — **Northstar Goods** at
<https://demo.replaythis.io> — with a deliberate bug baked in: apply coupon
`SAVE20` and the cart says *applied*, but the total never changes. Install the
plugin, open a task in any folder, and paste:

> Reproduce a bug on the Northstar Goods demo store at https://demo.replaythis.io
> using Replay's browser tools. Add two products to the cart, apply coupon code
> `SAVE20`, and proceed to checkout. The bug: the cart announces *"Coupon SAVE20
> applied — 20% off"*, but the order **total never changes** — it stays at the full
> subtotal. Capture a replay of the whole reproduction, drop a `replay_marker` on
> the action where you apply the coupon, then return the replay link.

Your agent reproduces the bug on the live site and hands back a replay link with
the dead air already cut.

### What you get back

- A single browser-session timeline — captured tabs, focus changes, and page
  reload/navigation transitions.
- Captured DOM events, markers, and the static assets needed for local replay.
- Idle treatment you control (Cut, fast-forward, or Keep), plus seeking, speed
  controls, and keyboard play/pause.
- A local-only **Ask AI** replay assistant (powered by your own Codex CLI) that
  answers questions about the replay and can seek, pause, and highlight elements
  while it explains. Disable or tune it in
  [configuration](docs/configuration.md).

Passwords are masked. Replays never include scripts, API responses, or assets
larger than 10 MiB.

## Troubleshooting

- **No page available:** have the agent navigate the target app through
  Playwright, then start the replay.
- **Empty replay or the wrong browser:** make sure the agent drives Replay's own
  `browser_*` tools. A separately configured stock Playwright MCP controls a
  browser Replay never captures.
- **Chrome cannot start:** install Google Chrome, or set
  `REPLAY_BROWSER_EXECUTABLE` to its executable path.

Don't use Web Preview, Codex's in-app browser, Arc, or a manually opened Chrome
for a replay — none are connected to Replay's capture.

## Uninstall

Stop Replay's tools from loading by removing it from your agent:

- **Codex:** `codex plugin remove replay-mcp@replay`
- **Claude Code:** remove the MCP server and the skill the installer added:
  ```sh
  claude mcp remove replay
  rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/replay-browser-capture"
  ```
- **Other MCP agents:** delete the Replay entry the installer added from your
  agent config.

Either way, your saved replays, the managed Chrome profile, and downloaded
runtimes stay in `~/.replay`. To reclaim that disk space too, stop any in-flight
capture first, then:

```sh
rm -rf ~/.replay
```

Replay installs no system services, LaunchAgents, or shared libraries, so
there's nothing else to clean up.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [MCP tools and lifecycle](docs/mcp.md)
- [Configuration](docs/configuration.md)
- [Replay format](docs/format.md)
- [Portable artifacts — import/export](docs/phase-3-portable-artifacts.md)
- [Railway share links](docs/phase-4-railway-sharing.md)
- [Remote query design](docs/phase-4b-remote-query.md)
- [Codex distribution and release build](docs/distribution.md)
- [Development and releases](docs/development-and-releases.md)
- [Fresh-agent acceptance checklist](docs/phase-2-acceptance.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
