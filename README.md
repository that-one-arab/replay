# replay

Replay lets a coding agent capture the browser session it uses to reproduce or verify
a change, then hand back a replay link and a portable `.replay` artifact.

## Install for Codex

Replay is installed as one ready-to-run package: the Replay runtime and its Codex
plugin, with the stock Playwright browser tools embedded. You do not clone this
repository, manually wire MCP paths, or configure a separate Playwright server.

Install **Replay browser replays** from the approved Codex marketplace, then
open a new Codex task. On its first use, the plugin downloads the correct
verified runtime into `~/.replay` and starts it automatically. Google Chrome is
required.

### Ask normally

Start the app under test, then open a Codex task in that app's project and say:

> Read BUG_TICKET.md, reproduce the issue, and capture a replay.

For a fix:

> Fix the issue, verify it in the browser, and capture a replay of the verified result.

Codex drives the browser and captures through the one Replay server, labelling
milestones with atomic `replay_marker` checkpoints on the actions themselves. It
returns a local replay URL and a portable artifact path
when finished. With `REPLAY_SHARE_URL` configured, `capture_stop` also publishes
the artifact automatically and returns a share URL. You do not need to start
Chrome, choose a port, or describe the replay workflow.

## Install for any MCP-capable agent

Replay is just an MCP server and bundles its own Node runtime, so you do **not**
need Node.js installed. One command fetches the pinned runtime into `~/.replay`
(macOS Apple Silicon only):

```sh
curl -fsSL https://raw.githubusercontent.com/that-one-arab/replay/main/install.sh | sh
```

Then register the server in your agent's MCP config (Claude Code `~/.claude.json`,
Cursor `~/.cursor/mcp.json`, etc.) using the `command` path the installer prints:

```json
{
  "mcpServers": {
    "replay": {
      "command": "/Users/<you>/.replay/runtimes/current/bin/replay-mcp"
    }
  }
}
```

The `current` symlink tracks the latest installed version, so the config survives
upgrades. Google Chrome is required (the managed browser Replay drives). To pin a
version, set `REPLAY_VERSION` (e.g. `REPLAY_VERSION=0.2.2`) before running the
installer; set `REPLAY_HOME` to install elsewhere.

## Quick start against the live demo

No project of your own? There is a live demo storefront — **Northstar Goods** at
<https://demo.replaythis.io> — with a deliberate bug baked in: apply coupon
`SAVE20` and the cart says *applied*, but the total never changes. Install the
plugin, open a Codex task in any folder, and paste:

> Reproduce a bug on the Northstar Goods demo store at https://demo.replaythis.io
> using Replay's browser tools. Add two products to the cart, apply coupon code
> `SAVE20`, and proceed to checkout. The bug: the cart announces *"Coupon SAVE20
> applied — 20% off"*, but the order **total never changes** — it stays at the full
> subtotal. Capture a replay of the whole reproduction, drop a `replay_marker` on
> the action where you apply the coupon, then return the replay link.

Your agent reproduces the bug on the live site and hands back a replay link with
the dead air already cut.

## What a replay includes

- A single browser-session timeline, including captured tabs, focus changes, and
  page reload or navigation transitions.
- Captured DOM events, markers, and static assets needed for local replay.
- Configurable idle treatment (Cut, fast-forward, or Keep), plus seeking, speed
  controls, and keyboard play/pause.
- A local-only **Ask AI** replay assistant (powered by your own Codex CLI) that
  answers questions about the replay and can seek, pause, and highlight
  elements in the replay while it explains. See
  [configuration](docs/configuration.md) to disable or tune it.

Passwords are masked. Replays do not include scripts, API responses, or assets
larger than 10 MiB.

## If something goes wrong

- **No page available:** have the agent navigate the target app through
  Playwright, then start the replay.
- **Empty replay or the wrong browser:** make sure the agent drives Replay's own
  `browser_*` tools. A separately configured stock Playwright MCP controls a
  browser Replay never captures.
- **Chrome cannot start:** install Google Chrome or set `REPLAY_BROWSER_EXECUTABLE`
  to its executable path.

Do not use Web Preview, Codex's in-app browser, Arc, or a manually opened Chrome
for a replay; they are not connected to Replay's capture.

## Configure Replay

Replay can use a visible local Chrome for interactive work or a hidden local Chrome
for unattended runs. Replay defaults travel with each replay. See
[configuration](docs/configuration.md) for the TOML file, settings precedence,
and the required browser restart after changing launch settings.

## Uninstall

Remove the Codex plugin to stop Replay's tools from loading in new tasks:

```sh
codex plugin remove replay-mcp@replay
```

That leaves your saved replays, the managed Chrome profile, and downloaded
runtimes in `~/.replay`. To reclaim that disk space too, stop any in-flight
capture first, then:

```sh
rm -rf ~/.replay
```

Replay installs no system services, LaunchAgents, or shared libraries, so there
is nothing else to clean up.

## Development and manual use

The direct CLI and source build are for contributors and troubleshooting, not
the normal coding-agent workflow. Build a checkout first:

```sh
pnpm install
pnpm build
```

Then use the CLI:

```sh
pnpm replay browser start
pnpm replay start --title "Checkout repro"
pnpm replay marker "Submitting checkout"
pnpm replay stop --outcome reproduced
```

`pnpm replay open <session-id>` prints a replay URL. The included deterministic
demo can also create single- or multi-tab replays:

```sh
pnpm demo:capture
pnpm demo:capture --multi-tab
```

## Move a replay to another machine

Stopping a replay automatically creates `~/.replay/exports/<session-id>.replay`.
You can also export an earlier replay or import an artifact received from
someone else:

```sh
pnpm replay export <session-id> --output ./bug-repro.replay
pnpm replay import ./bug-repro.replay
pnpm replay open <imported-session-id>
```

Import verifies the artifact’s contents before installing it and never overwrites
an existing replay. The recipient needs Replay installed locally, but not access
to the replay machine or browser.

## Share a replay (Railway prototype)

Deploy the included share service to Railway with a persistent `/data` volume,
then set its public URL locally:

```sh
export REPLAY_SHARE_URL=https://<your-service-domain>
pnpm replay share <session-id>
```

For a coding agent, `capture_stop` uploads automatically when `REPLAY_SHARE_URL`
is configured. The command above is only a recovery path for an earlier local
replay. A resulting link is currently an unlisted bearer link—anyone with it
can view the replay—so use only non-sensitive replays. Deployment, agent
usage, and limitations are in the [Railway sharing guide](docs/phase-4-railway-sharing.md).

A share link is also agent-readable: `GET /r/<id>.md` (or the bare link with
`Accept: text/markdown`) returns a prompt-ready summary any coding agent can
fetch, `/r/<id>.json` returns it structured, and the `replay_overview`,
`replay_steps`, and `replay_fetch` MCP tools read or import a shared replay
straight from the pasted link. See the
[remote query design](docs/phase-4b-remote-query.md).

## Documentation

- [Architecture](ARCHITECTURE.md)
- [MCP tools and lifecycle](docs/mcp.md)
- [Replay format](docs/format.md)
- [Portable artifacts: implementation and E2E guide](docs/phase-3-portable-artifacts.md)
- [Railway share links](docs/phase-4-railway-sharing.md)
- [Configuration](docs/configuration.md)
- [Fresh-agent acceptance checklist](docs/phase-2-acceptance.md)
- [Codex distribution and release build](docs/distribution.md)
- [Development and releases](docs/development-and-releases.md)
- [Changelog](CHANGELOG.md)
- [Roadmap](docs/roadmap.md)
