# AGENTS.md

Guidance for coding agents working in this repository. Keep changes consistent
with the architecture below; `ARCHITECTURE.md` is the deeper maintainer map.

## What Replay is

Replay captures the browser journey a coding agent performs, stores it as a
portable DOM-based replay, and hands it back locally or via an optional share
link. The load-bearing separation: **Playwright drives the browser; Replay only
observes and captures it.** Never proxy, wrap, or reimplement Playwright tools
inside Replay.

## Commands

pnpm is required (workspace uses `pnpm-workspace.yaml`).

- `pnpm install` — install workspace deps.
- `pnpm build` — compile every package with `tsc`, then build the player with Vite.
- `pnpm check` — typecheck all packages (`tsc --noEmit`), no emit.
- `pnpm test` — run the suite.
- `pnpm replay <cmd>` — the CLI (`browser start`, `start`, `marker`, `stop`, `open`, `export`, `import`, `share`, `daemon stop`).

### Tests run against compiled output

`pnpm test` runs `node --test` over the **`dist/`** files, not the `src/`
TypeScript. So:

- **Always `pnpm build` before `pnpm test`** or you are testing stale code.
- Run one file: `pnpm build && node --test packages/mcp/dist/main.test.js`.
- Filter by name: add `--test-name-pattern="<substring>"`.
- The player E2E (`packages/demo/dist/player.e2e.test.js`) is gated on a local
  Chrome and is skipped without one; set `REPLAY_BROWSER_EXECUTABLE` to run it.

## Package map

Monorepo under `packages/*` (plus the Codex plugin under `plugins/`).

- `core` — the capture (CDP + rrweb capture), session storage, `.replay`
  export/import (`bundle.ts`), and config resolution. No HTTP/MCP/UI.
- `daemon` — one local HTTP server on `127.0.0.1:${REPLAY_PORT}` (default 7717):
  Chrome lifecycle, replay endpoints, replay/player serving, daemon leases.
- `mcp` — stdio JSON-RPC MCP server exposing the `recording_*` tools.
- `playwright-launcher` — a near-transparent rendezvous that starts stock
  `@playwright/mcp` against Replay's managed Chrome.
- `player` — Vite-built replay UI served by the daemon and share server.
- `share-server` — hosted replay, bearer-link lookup, and the runtime release feed.
- `cli`, `demo`, `runtime` — contributor CLI, deterministic demo/E2E, packaged entry points.
- `plugins/replay-mcp` — the Codex marketplace plugin (bootstrap + skill only).

`ARCHITECTURE.md` has a "Development map" table pointing each kind of change to
its starting file.

## Runtime model and invariants

- **The daemon is long-lived and runs compiled `dist/`.** After changing daemon,
  core, or MCP code, `pnpm build` **and restart the daemon** — an already-running
  daemon keeps serving old code in memory. `pnpm replay daemon stop` (or kill the
  process on its port) lets it relaunch fresh on the next call.
- **Chrome launches lazily.** The launcher does not open Chrome at startup; it
  provisions Replay's managed Chrome only on the first `tools/call`. Managed Chrome
  always exposes the fixed loopback CDP endpoint `http://127.0.0.1:9333`.
- **Replay lifecycle:** `capture_start` is valid only after a navigated
  in-scope page exists (prevents empty replays). Markers are ordered narrative
  metadata — never issue a Playwright action and a `capture_marker` in parallel.
- **Sharing is explicit.** `capture_stop` saves and previews locally and does
  **not** upload. Uploading happens via the `replay_share` tool or the
  player's Share button, and requires `REPLAY_SHARE_URL`.
- **Exports are write-exclusive.** `exportSession` writes the `.replay` with an
  exclusive flag; reuse the existing `exportPath(id)` artifact instead of
  re-exporting a stopped replay (see `daemon` share handling).
- **Config precedence** (per key): built-in defaults → user `~/.replay/config.toml`
  → project `.replay/config.toml` → `REPLAY_CONFIG` → `REPLAY_*` env vars. Browser launch
  settings are fixed while a managed Chrome is running; a change reports
  `restart_required` rather than interrupting it.

## Development

Replay runs as a marketplace plugin against a packaged runtime (home `~/.replay`,
daemon `127.0.0.1:7717`). Develop from this checkout with `pnpm build` then
`pnpm replay ...` — the CLI drives the daemon directly and needs no Codex plugin
registered. Inspect the registered plugin with `pnpm codex:status`; remove it
with `pnpm codex:uninstall`. See `docs/development-and-releases.md`.

## Releases

A git push is not a release. Bump every version with `pnpm release:version
<version>`, validate (`pnpm build && pnpm check && pnpm test`), build the
archive (`pnpm package:macos` — it asserts the release version as its first
step), then publish to the release feed. Runtime distribution currently targets `darwin-arm64` only.

## Conventions

- TypeScript, `strict`, ES2022 / NodeNext modules. Match the terse,
  single-responsibility style of surrounding code and its comment density.
- Use sentence case in prose and headings (not title case).
