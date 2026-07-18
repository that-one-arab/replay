# `@rec/daemon`

The local HTTP runtime that owns one Rec recorder and its managed Chrome
connection. It binds to loopback only (`127.0.0.1:7717` by default).

The daemon:

- Launches, reuses, or attaches a loopback CDP browser.
- Starts and stops recordings through `@rec/core`.
- Exports a portable bundle when a recording stops.
- Serves local replay data and the built player at `/replay`.
- Applies Rec configuration to browser launch and recording replay defaults.
- Tracks short-lived agent and replay leases so it can release managed Chrome
  after agent work ends, while leaving local replay available for a grace period.

It is normally started on demand by `rec-mcp`, the Playwright launcher, or the
CLI—not by an end user directly. Use `REC_PORT`, `REC_HOME`, and `REC_CONFIG`
only for development or deliberate isolation.

An agent lease lasts while Rec MCP or the Playwright launcher is running. Once
the final agent lease ends, the daemon stops only Rec-owned Chrome after
`REC_BROWSER_IDLE_TIMEOUT_MS` (30 seconds by default). A local replay holds a
replay-only lease, which keeps the daemon serving the recording without keeping
Chrome open. With no leases, the daemon exits after
`REC_DAEMON_IDLE_TIMEOUT_MS` (15 minutes by default). Use `rec daemon stop` to
end it immediately when no recording is active.

Run `pnpm --filter @rec/daemon build` after changes. The API is an
internal local contract; agent-facing usage is documented in
[the MCP guide](../../docs/mcp.md).
