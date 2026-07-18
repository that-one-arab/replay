# `@rec/core`

The recording engine and portable-artifact library shared by every Rec runtime.

It owns:

- CDP-backed rrweb recording, browser tab lifecycle, navigation metadata, markers, and captured static assets.
- Session storage under `REC_HOME` (default `~/.rec`).
- Portable `.rec` export/import with manifest and file integrity checks.
- Rec TOML configuration resolution and the replay defaults persisted in new manifests.

It deliberately has no HTTP server, CLI, MCP protocol, or player UI. Those live
in sibling packages.

Build or check from the repository root with `pnpm --filter @rec/core build`
or `pnpm --filter @rec/core check`.

See the root [recording format](../../docs/format.md) and
[configuration guide](../../docs/configuration.md).
