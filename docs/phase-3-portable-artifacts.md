# Phase 3 — portable replay artifacts

## Outcome

A completed Replay session can move independently of the machine that captured it.
`capture_stop` creates a portable `.replay` artifact automatically, and the CLI
can export any existing session or import an artifact on another Replay installation.
An imported session is served by the normal local replay viewer; it does not need
the source machine's browser, daemon process, or `REPLAY_HOME` directory.

This phase deliberately solves portability, not hosted sharing, authentication,
encryption, or redaction beyond the capture's existing password masking. Do not
treat a `.replay` artifact as safe to send outside its intended audience.

## User-facing workflow

When a replay stops, the daemon writes:

```text
~/.replay/exports/<session-id>.replay
```

The MCP `capture_stop` response includes that location as
`portableArtifactPath`, alongside `replayUrl`. A coding agent can include both in
its handoff without a second replay call.

For an older replay, or to choose a destination explicitly:

```sh
pnpm replay export <session-id> --output ./bug-repro.replay
```

The recipient imports the file and opens the returned session ID:

```sh
pnpm replay import ./bug-repro.replay
pnpm replay open <session-id>
```

`replay import` refuses to overwrite an existing replay ID. Re-exporting to an
existing destination also fails rather than silently replacing a file.

## Artifact contract

The `.replay` extension denotes a gzip-compressed JSON envelope. Version 1 contains:

- `kind: "replay-portable-bundle"` and `format_version: 1`;
- the complete replay manifest and a manifest SHA-256 checksum;
- every event chunk referenced by the manifest;
- every captured asset referenced by the manifest;
- `markers.json` when present; and
- per-file path, byte length, and SHA-256 checksum.

The archive is intentionally a simple local transport format rather than a new
database or a player-specific export. The imported session recreates the normal
spool layout, so existing daemon asset and replay endpoints continue to work
unchanged. See [format.md](format.md) for the session directory format.

Checksums detect corruption or an incomplete transfer. They are not a signature:
an artifact is not authenticated merely because it passes import validation.

## Import rules

Import validates the bundle before it creates the target session directory:

1. Decompress and parse the supported envelope version.
2. Verify the manifest checksum.
3. Derive the exact expected chunk and asset paths from that manifest.
4. Reject duplicate, missing, unexpected, or traversal-like paths.
5. Verify every included file's decoded size and SHA-256 checksum.
6. Write to a temporary directory, then atomically rename it into `sessions/`.

The replay ID is preserved because captured asset URLs reference it. Therefore
an import collision is an error, not a rename. Future artifact versions may add a
safe ID-rewrite migration if that becomes necessary.

## Code ownership

| Area | Location | Responsibility |
| --- | --- | --- |
| Bundle encoding/import validation | `packages/core/src/bundle.ts` | Version, checksums, safe paths, atomic import. |
| Local session format | `packages/core/src/storage.ts` and `docs/format.md` | Manifest, event chunks, assets, and spool paths. |
| Automatic stop export | `packages/daemon/src/main.ts` | Creates the default artifact and includes its path in the stop response. |
| CLI | `packages/cli/src/main.ts` | `replay export` and `replay import` commands. |
| Agent handoff | `packages/mcp/src/main.ts` | Maps the daemon result to `portableArtifactPath`. |
| Regression coverage | `packages/core/src/storage.test.ts`, `packages/mcp/src/main.test.ts` | Round trip, corruption rejection, collision protection, and MCP handoff field. |

## Manual E2E test

Use a finished session from the source environment:

```sh
pnpm replay export replay_example --output /tmp/replay-example.replay
```

Simulate a recipient in a fresh spool and use a different daemon port. The port
is important: otherwise the CLI can reuse the source daemon and mask an isolation
failure.

```sh
export REPLAY_HOME="$(mktemp -d)"
export REPLAY_PORT=7720

pnpm replay import /tmp/replay-example.replay
pnpm replay open replay_example
```

Open the returned `http://127.0.0.1:7720/replay?...` URL and verify timeline,
markers, tabs, navigation intervals, and captured assets. Repeat the import to
confirm that it rejects the ID collision.

## Follow-on work

Phase 4 will make this same artifact uploadable and viewable through a durable
share URL. Keep the artifact envelope backward compatible: a future service
should ingest and retain the manifest/chunks/assets rather than inventing a
parallel replay representation. Security, access control, expiry, revocation,
and a review experience are explicitly deferred until that sharing phase.
