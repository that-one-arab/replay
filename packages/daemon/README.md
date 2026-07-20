# `@replay/daemon`

The local HTTP runtime that owns one Replay capture and its managed Chrome
connection. It binds to loopback only (`127.0.0.1:7717` by default).

The daemon:

- Launches, reuses, or attaches a loopback CDP browser.
- Starts and stops replays through `@replay/core`.
- Exports a portable bundle when a replay stops.
- Serves local replay data and the built player at `/replay`.
- Applies Replay configuration to browser launch and replay replay defaults.
- Tracks short-lived agent and replay leases so it can release managed Chrome
  after agent work ends, while leaving local replay available for a grace period.

It is normally started on demand by `replay-mcp`, the Playwright launcher, or the
CLI—not by an end user directly. Use `REPLAY_PORT`, `REPLAY_HOME`, and `REPLAY_CONFIG`
only for development or deliberate isolation.

An agent lease lasts while Replay MCP or the Playwright launcher is running. Once
the final agent lease ends, the daemon stops only Replay-owned Chrome after
`REPLAY_BROWSER_IDLE_TIMEOUT_MS` (30 seconds by default). A local replay holds a
replay-only lease, which keeps the daemon serving the replay without keeping
Chrome open. With no leases, the daemon exits after
`REPLAY_DAEMON_IDLE_TIMEOUT_MS` (15 minutes by default). Use `replay daemon stop` to
end it immediately when no replay is active.

Run `pnpm --filter @replay/daemon build` after changes. The API is an
internal local contract; agent-facing usage is documented in
[the MCP guide](../../docs/mcp.md).
