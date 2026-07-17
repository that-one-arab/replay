# rec

`rec` is a local-first, DOM-based browser session recorder for agent-driven Chromium
sessions. It attaches over CDP, records rrweb events, writes a crash-tolerant gzip
bundle, and serves a local replay with idle time skipped by default.

This repository contains the completed local Phase 1 implementation and the
in-progress local MCP capture workflow from Phase 2. It has no hosted ingest or
auth; recordings stay on the machine that created them.

## Quick start

```sh
pnpm install
pnpm build
# For CLI/script use, start the managed browser and point Playwright at its endpoint.
pnpm rec browser start
pnpm rec start --title "Checkout repro"
pnpm rec marker "Submitting checkout"
pnpm rec stop --outcome reproduced
pnpm rec open <session-id>
```

`rec browser start` uses macOS Google Chrome when available. Set
`REC_BROWSER_EXECUTABLE` to override it. A browser may also be launched separately
with a remote debugging port and attached using `rec attach --cdp <url>`.

Recordings are stored in `~/.rec/sessions` (or `REC_HOME`). Passwords are always
masked; pass `--mask-all-inputs` for sensitive flows. `--origin` may be repeated to
strictly scope what pages are captured. Static CSS, image, and font resources are
copied into the recording when available, so replay does not depend on those live
resources. The recorder intentionally excludes scripts, API responses, and assets
larger than 10 MiB.

Canvas recording is opt-in because it can include sensitive pixels and substantially
increase bundle size:

```sh
pnpm rec start --title "Canvas repro" --origin https://app.example --record-canvas
```

To capture a cross-origin iframe through rrweb's bridge, explicitly scope both the
parent and iframe origins. Any iframe outside that allowlist is replaced in replay by
an explanatory placeholder, rather than loading a live external page.

## Commands

```text
rec browser start|stop
rec attach --cdp <url>
rec start [--title <text>] [--origin <origin>] [--mask-all-inputs] [--record-canvas]
rec marker <label> [--note <text>]
rec stop [--outcome reproduced|verified|other] [--notes <text>]
rec status | list | open <id> | doctor
```

For Codex, the installed Rec plugin launches stock Playwright MCP through Rec's
bridge automatically. The coding agent can use Playwright first and begin a
recording later; developers do not need to start Chrome or provide a CDP port.

## Replay behavior

- A recording is a browser session: multi-tab runs expose a tab strip and one
  shared timeline in the player. Tabs appear and receive focus at their recorded
  creation time during playback.
- Static resources are served from the local session bundle at replay time.
- Idle time is skipped by default; controls expose seeking, speed, and keyboard
  play/pause.

The recording format is documented in `docs/format.md`; the spike checklist is in
`docs/spike-checklist.md`. The path from this completed local implementation to
agent-native capture and shared replay is in `docs/roadmap.md`; the current Phase 2
contract is in `docs/phase-2-agent-native-capture-plan.md`. The local stdio MCP
server is documented in `docs/mcp.md`.

## Deterministic demo replay

The included Orbit onboarding app is a repeatable source for validating the recorder
against a real Playwright-driven browser session. It launches the demo app, starts a
recording using the same `rec` CLI commands an agent would use, performs the journey,
and prints the resulting replay URL.

```sh
npm run build
npm run demo:record        # single-tab browser session
npm run demo:record:multi  # browser session that opens an invite-preview tab
```
