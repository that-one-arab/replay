# `@signit/rec-cli`

The developer and troubleshooting command-line interface. Its executable is
`rec`; the workspace exposes it as `pnpm rec`.

Useful commands include:

```sh
pnpm rec status
pnpm rec browser start
pnpm rec config show
pnpm rec export <session-id> --output ./recording.rec
pnpm rec import ./recording.rec
```

The normal coding-agent flow does not use the CLI: Rec MCP records while
Playwright MCP drives the browser. The CLI is useful for local inspection,
portable artifact recovery, and manual sharing retries.

See the root README and [configuration guide](../../docs/configuration.md).
