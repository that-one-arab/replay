# Development and releases

Replay runs as a marketplace plugin against a packaged runtime. All
browser/session state lives under `~/.replay`, with the daemon on
`127.0.0.1:7717`.

Develop from a source checkout through the CLI, not through a separate Codex
lane: build with `pnpm build`, then drive captures with `pnpm replay ...` (see
the README's "Development and manual use"). The CLI talks to the daemon directly
and needs no plugin registered, so it does not disturb the marketplace install.

Inspect or remove the registered plugin:

```sh
pnpm codex:status
pnpm codex:uninstall            # removes the plugin; keeps saved replays and runtimes
pnpm codex:uninstall -- --purge # also removes ~/.replay
```

## Production release process

A Git push is not a Replay release. Users receive a new runtime only after an
immutable archive is published to the release feed and the plugin marketplace
has been updated.

1. Commit the implementation and choose the next `MAJOR.MINOR.PATCH` version.
2. Update every release version in one operation:

   ```sh
   pnpm release:version <version>
   ```

   Add the matching `CHANGELOG.md` entry.

3. Validate the release:

   ```sh
   pnpm release:check
   pnpm build
   pnpm check
   pnpm test
   ```

4. Build the Apple-silicon macOS archive:

   ```sh
   pnpm package:macos
   ```

5. Publish the generated `.artifacts/replay-<version>-darwin-arm64.tar.gz` using
   the maintainer publishing token:

   ```sh
   REPLAY_RELEASE_PUBLISH_TOKEN=<token> \
     node scripts/publish-release.mjs .artifacts/replay-<version>-darwin-arm64.tar.gz
   ```

   The release feed rejects attempts to replace an existing version/platform
   pair. Verify its exact metadata endpoint before updating the marketplace:

   ```text
   GET /v1/releases/<version>?platform=darwin-arm64
   ```

6. Copy `plugins/replay-mcp` into the plugin-only marketplace repository, commit
   and push it. The plugin's manifest version and both
   `REPLAY_RUNTIME_VERSION` values must equal the released runtime version;
   `pnpm release:check` enforces the source-copy invariant.

7. Verify from an isolated runtime directory that the marketplace plugin
   downloads the published archive and that a fresh Codex task starts it.

8. Tell users to upgrade deliberately:

   ```sh
   codex plugin marketplace upgrade replay
   codex plugin add replay-mcp@replay
   ```

   They then open a new Codex task. The updated plugin requests exactly its own
   runtime version and installs it under `~/.replay/runtimes/<version>`.

## Upgrade and rollback behavior

Production plugins pin their runtime with `REPLAY_RUNTIME_VERSION`. A plugin at
version `X.Y.Z` requests only runtime `X.Y.Z`; it does not silently adopt the
highest release in the feed. The old `/latest` endpoint remains available for
diagnostics and pre-pin plugins, but production plugins do not use it.

To roll back, republish neither the archive nor the same version—both are
immutable. Instead, restore the earlier plugin revision in the marketplace and
reinstall it. Its pin selects the previously published runtime, which remains in
the release feed and can be reused from the local runtime cache.
