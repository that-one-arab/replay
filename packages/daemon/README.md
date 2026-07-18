# `@rec/daemon`

The local HTTP runtime that owns one Rec recorder and its managed Chrome
connection. It binds to loopback only (`127.0.0.1:7717` by default).

The daemon:

- Launches, reuses, or attaches a loopback CDP browser.
- Starts and stops recordings through `@rec/core`.
- Exports a portable bundle when a recording stops.
- Serves local replay data and the built player at `/replay`.
- Applies Rec configuration to browser launch and recording replay defaults.

It is normally started on demand by `rec-mcp`, the Playwright launcher, or the
CLI—not by an end user directly. Use `REC_PORT`, `REC_HOME`, and `REC_CONFIG`
only for development or deliberate isolation.

Run `pnpm --filter @rec/daemon build` after changes. The API is an
internal local contract; agent-facing usage is documented in
[the MCP guide](../../docs/mcp.md).
