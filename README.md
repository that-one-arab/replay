# rec

Rec lets a coding agent record the browser session it uses to reproduce or verify
a change, then hand back a local replay link and a portable `.rec` artifact.
There is no hosted service or sharing layer yet.

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
env = { REC_SHARE_URL = "https://<your-service-domain>" } # Optional: publish on recording_stop

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
and optional markers. It returns a local replay URL and a portable artifact path
when finished. With `REC_SHARE_URL` configured, `recording_stop` also publishes
the artifact automatically and returns a share URL. You do not need to start
Chrome, choose a port, or describe the recording workflow.

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

## Move a replay to another machine

Stopping a recording automatically creates `~/.rec/exports/<session-id>.rec`.
You can also export an earlier recording or import an artifact received from
someone else:

```sh
pnpm rec export <session-id> --output ./bug-repro.rec
pnpm rec import ./bug-repro.rec
pnpm rec open <imported-session-id>
```

Import verifies the artifact’s contents before installing it and never overwrites
an existing recording. The recipient needs Rec installed locally, but not access
to the recording machine or browser.

## Share a replay (Railway prototype)

Deploy the included share service to Railway with a persistent `/data` volume,
then set its public URL locally:

```sh
export REC_SHARE_URL=https://<your-service-domain>
pnpm rec share <session-id>
```

This is an explicit upload after recording stops. The resulting link is currently
an unlisted bearer link—anyone with it can view the recording—so use only
non-sensitive recordings. Deployment, agent usage, and limitations are in the
[Railway sharing guide](docs/phase-4-railway-sharing.md).

## Documentation

- [MCP tools and lifecycle](docs/mcp.md)
- [Recording format](docs/format.md)
- [Portable artifacts: implementation and E2E guide](docs/phase-3-portable-artifacts.md)
- [Railway share links](docs/phase-4-railway-sharing.md)
- [Fresh-agent acceptance checklist](docs/phase-2-acceptance.md)
- [Roadmap](docs/roadmap.md)
