# rec

Rec lets a coding agent record the browser session it uses to reproduce or verify
a change, then hand back a local replay link. Recordings stay on the machine that
created them; there is no hosted service or sharing layer yet.

## Quick start: Codex

Rec records while stock Playwright MCP drives the browser. Install both MCP
servers in the project where Codex will work.

### 1. Build Rec

```sh
cd /absolute/path/to/rec
pnpm install
pnpm build
```

Node.js, `npx`, and Google Chrome must be available. The launcher obtains the
separate `@playwright/mcp` dependency on first use.

### 2. Configure Codex

Create or update `<target-project>/.codex/config.toml`. Replace
`/absolute/path/to/rec` with this checkout's real path.

```toml
[mcp_servers.rec]
command = "node"
args = ["/absolute/path/to/rec/packages/mcp/dist/main.js"]

[mcp_servers.playwright]
command = "node"
args = ["/absolute/path/to/rec/packages/playwright-launcher/dist/main.js"]
```

Restart Codex or open a new task. The Playwright entry must point to Rec's
launcher, not directly to stock Playwright MCP: the launcher starts Rec's
dedicated Chrome when needed and connects Playwright to that same browser.

### 3. Ask normally

Start the app under test, then open a Codex task in that app's project and say:

> Read BUG_TICKET.md, reproduce the issue, and capture a Rec replay.

For a fix:

> Fix the issue, verify it in the browser, and record a Rec replay of the verified result.

Codex uses Playwright for every browser action and Rec for recording lifecycle
and optional markers. It returns a local replay URL when finished. You do not
need to start Chrome, choose a port, or describe the recording workflow.

## What a replay includes

- A single browser-session timeline, including recorded tabs, focus changes, and
  page reload or navigation transitions.
- Captured DOM events, markers, and static assets needed for local replay.
- Idle time reduced by default, plus seeking, speed controls, and keyboard
  play/pause.

Passwords are masked. Recordings do not include scripts, API responses, or assets
larger than 10 MiB.

## If something goes wrong

- **No page available:** have the agent navigate the target app through
  Playwright, then start the recording.
- **Empty replay or the wrong browser:** make sure the `playwright` MCP entry
  points to `packages/playwright-launcher/dist/main.js`, not stock Playwright
  MCP directly.
- **Chrome cannot start:** install Google Chrome or set `REC_BROWSER_EXECUTABLE`
  to its executable path.

Do not use Web Preview, Codex's in-app browser, Arc, or a manually opened Chrome
for a Rec recording; they are not connected to Rec's recorder.

## Development and manual use

The direct CLI is for developing or troubleshooting Rec, rather than the normal
coding-agent workflow:

```sh
pnpm rec browser start
pnpm rec start --title "Checkout repro"
pnpm rec marker "Submitting checkout"
pnpm rec stop --outcome reproduced
```

`pnpm rec open <session-id>` prints a replay URL. The included deterministic
demo can also create single- or multi-tab recordings:

```sh
pnpm demo:record
pnpm demo:record:multi
```

## Documentation

- [MCP tools and lifecycle](docs/mcp.md)
- [Recording format](docs/format.md)
- [Fresh-agent acceptance checklist](docs/phase-2-acceptance.md)
- [Roadmap](docs/roadmap.md)
