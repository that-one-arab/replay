# `@replay/core`

The replay engine and portable-artifact library shared by every Replay runtime.

It owns:

- CDP-backed rrweb replay, browser tab lifecycle, navigation metadata, markers, and captured static assets.
- Session storage under `REPLAY_HOME` (default `~/.replay`).
- Portable `.replay` export/import with manifest and file integrity checks.
- Replay TOML configuration resolution and the replay defaults persisted in new manifests.

It deliberately has no HTTP server, CLI, MCP protocol, or player UI. Those live
in sibling packages.

Build or check from the repository root with `pnpm --filter @replay/core build`
or `pnpm --filter @replay/core check`.

See the root [replay format](../../docs/format.md) and
[configuration guide](../../docs/configuration.md).
