# `@rec/playwright-launcher`

**Escape hatch.** Rec's MCP server embeds a pinned stock Playwright MCP, so a
default setup needs no separate `playwright` entry and no launcher. Use this
package only when you must run a specific, separately installed Playwright MCP
version instead of the embedded one.

It is a stdio-transparent bootstrapper for that separately installed Playwright
MCP. Its executable is `rec-playwright-launcher`.

Before starting stock Playwright MCP, it ensures Rec’s managed Chrome exists and
passes that Chrome’s CDP endpoint to Playwright. It then forwards standard input
and output unchanged; it never implements, proxies, or records Playwright tools.
Because the tool traffic bypasses Rec, `rec_marker` is unavailable on this path:
only ordered `recording_marker` calls associate checkpoints with actions.

To use it, set `REC_EMBEDDED_PLAYWRIGHT=0` on the `rec` MCP entry and point a
`playwright` MCP entry at this executable. Do not point that entry directly at
stock Playwright MCP, or the browser it controls will not be captured by Rec.
By default it runs `npx -y @playwright/mcp@latest`; set
`REC_PLAYWRIGHT_MCP_COMMAND` and `REC_PLAYWRIGHT_MCP_ARGS` (a JSON string
array) to use a pinned or locally installed Playwright command instead.

See [MCP setup](../../docs/mcp.md) and [configuration](../../docs/configuration.md).
