# `@signit/rec-mcp`

Rec’s local stdio MCP server. It exposes recording lifecycle, browser setup,
status, markers, and replay handoff tools to a coding agent.

`recording_stop` is the normal terminal action: it stops the session, creates a
portable artifact, and, when `REC_SHARE_URL` is configured, uploads it and
returns `shareUrl`. Agents do not make a second sharing call.

This server does **not** drive a browser. Stock Playwright MCP does that through
the sibling `@signit/rec-playwright-launcher`, so both systems use the same
Rec-managed browser.

The binary entry point is `rec-mcp`. Configuration and all tool contracts are
documented in [MCP lifecycle](../../docs/mcp.md) and
[configuration](../../docs/configuration.md).
