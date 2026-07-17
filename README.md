# rec

`rec` is a local-first, DOM-based browser session recorder for agent-driven Chromium
sessions. It attaches over CDP, records rrweb events, writes a crash-tolerant gzip
bundle, and serves a local replay with idle time skipped by default.

This repository is the Phase 0 spike. It intentionally includes no hosted ingest,
auth, MCP server, or asset proxy yet.

## Quick start

```sh
pnpm install
pnpm build
pnpm rec browser start
# Point Playwright MCP (or a Playwright script) at http://127.0.0.1:9333.
# The CDP endpoint is for Playwright, not a page to open in a browser.
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
strictly scope what pages are captured.

## Commands

```text
rec browser start|stop
rec attach --cdp <url>
rec start [--title <text>] [--origin <origin>] [--mask-all-inputs]
rec marker <label> [--note <text>]
rec stop [--outcome reproduced|verified|other] [--notes <text>]
rec status | list | open <id> | doctor
```

## Phase 0 evidence to collect

- CDP coexistence with the browser driver across navigation and popups.
- Fidelity and artifact size for the target app.
- Wall-clock versus active duration compression.
- Failure modes around iframe, canvas, and cross-origin assets.

The recording format is documented in `docs/format.md`; the spike checklist is in
`docs/spike-checklist.md`.
