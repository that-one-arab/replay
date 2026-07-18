# `@rec/playwright-launcher`

A stdio-transparent bootstrapper for the separately installed Playwright MCP.
Its executable is `rec-playwright-launcher`.

Before starting stock Playwright MCP, it ensures Rec’s managed Chrome exists and
passes that Chrome’s CDP endpoint to Playwright. It then forwards standard input
and output unchanged; it never implements, proxies, or records Playwright tools.

Use this executable for the `playwright` MCP entry in a Rec-enabled coding-agent
configuration. Do not point that entry directly at stock Playwright MCP, or the
browser it controls will not be captured by Rec.

See [MCP setup](../../docs/mcp.md) and [configuration](../../docs/configuration.md).
