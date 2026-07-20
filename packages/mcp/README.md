# `@replay/mcp`

Replay’s local stdio MCP server. It exposes replay lifecycle, browser setup,
status, markers, and replay handoff tools to a coding agent.

`capture_stop` is the normal terminal action: it stops the session, creates a
portable artifact, and, when `REPLAY_SHARE_URL` is configured, uploads it and
returns `shareUrl`. Agents do not make a second sharing call.

This server does **not** drive a browser. Stock Playwright MCP does that through
the sibling `@replay/playwright-launcher`, so both systems use the same
Replay-managed browser.

The binary entry point is `replay-mcp`. Configuration and all tool contracts are
documented in [MCP lifecycle](../../docs/mcp.md) and
[configuration](../../docs/configuration.md).
