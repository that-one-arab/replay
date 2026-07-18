# Rec runtime

`@rec/runtime` is the deployment-only package that groups the Rec CLI, daemon,
MCP server, Playwright launcher, and replay assets under stable executable
entry points. It is assembled into the macOS release archive by
`pnpm package:macos`; end users do not install this workspace package directly.

The wrappers set the daemon and player asset paths before loading each compiled
component, so the installed runtime never depends on a source checkout or its
working directory.
