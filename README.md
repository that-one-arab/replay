<img width="1480" height="915" alt="SCR-20260722-ceqq" src="https://github.com/user-attachments/assets/1e21bf56-b7ea-40fc-8bfe-b0fae379d5a8" />


# Replay

A coding agent captures the browser session it uses to reproduce or verify a
change, then hands back an annotated, shareable replay link and a portable
`.replay` artifact. The agent drives the browser **and** captures through one
Replay server — you never touch Chrome, ports, or capture config.

**Requires:** Google Chrome · macOS Apple Silicon

## Install

Install the runtime (bundles its own Node — no Node.js needed):

```sh
curl -fsSL https://raw.githubusercontent.com/that-one-arab/replay/main/install.sh | sh
```

**Claude Code & other MCP agents** — the installer also wires up the MCP server
and a `/replay-browser-capture` skill automatically.

**Codex** — after installing, register the MCP server:

```sh
codex mcp add replay --env REPLAY_SHARE_URL=https://share.replaythis.io -- ~/.replay/runtimes/current/bin/replay-mcp
```

Pin a version with `REPLAY_VERSION=0.3.0`; install elsewhere with `REPLAY_HOME`.

## Quickstart

Open an agent task in your app's project and ask normally:

> Read BUG_TICKET.md, reproduce the issue, and capture a replay.

or

> Fix the issue, verify it in the browser, and capture a replay.

The agent returns a local replay URL (and a share link when `REPLAY_SHARE_URL`
is set).

### Try the live demo

No project handy? Reproduce a bug on **Northstar Goods** →
<https://demo.replaythis.io>: coupon `SAVE20` announces *applied — 20% off*,
but the total never changes.

> Reproduce the SAVE20 bug on https://demo.replaythis.io with Replay's browser
> tools, drop a `replay_marker` when you apply the coupon, and return the
> replay link.

Just want to see the player? Inspect a finished replay of this bug at
<https://share.replaythis.io/demo>.

## What you get back

- One browser-session timeline — tabs, focus changes, navigations, DOM events,
  and markers.
- Idle trimming (cut / fast-forward / keep), seeking, and speed controls.
- A local **Ask AI** assistant that answers questions about the replay and
  highlights elements as it explains.

Passwords are masked. Replays exclude scripts, API responses, and assets over
10 MiB.

## Troubleshooting

- **No page / wrong browser:** the agent must drive Replay's own `browser_*`
  tools — not a stock Playwright MCP, Web Preview, Codex's in-app browser, or a
  manually opened Chrome.
- **Chrome won't start:** install Google Chrome, or set
  `REPLAY_BROWSER_EXECUTABLE` to its path.

## Uninstall

- **Codex:** `codex mcp remove replay`
- **Claude Code:** `claude mcp remove replay` and
  `rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/replay-browser-capture"`
- Reclaim disk: `rm -rf ~/.replay`

## Docs

[Architecture](ARCHITECTURE.md) · [MCP tools](docs/mcp.md) ·
[Configuration](docs/configuration.md) · [Replay format](docs/format.md) ·
[Portable artifacts](docs/phase-3-portable-artifacts.md) ·
[Share links](docs/phase-4-railway-sharing.md) ·
[Distribution](docs/distribution.md) ·
[Development](docs/development-and-releases.md) ·
[Roadmap](docs/roadmap.md) · [Changelog](CHANGELOG.md)
