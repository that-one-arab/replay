# Development and release lanes

Rec has two intentionally separate ways to run. Do not enable both at once:
they each expose the MCP server names `rec` and `playwright`.

| Lane | Code | Browser/session state | Daemon | Sharing |
| --- | --- | --- | --- | --- |
| Production | Marketplace plugin and packaged runtime | `~/.rec` | `127.0.0.1:7717` | Enabled by the production plugin |
| Development | Current source checkout | `~/.rec-dev` | `127.0.0.1:7718` | Disabled |

The state split includes the Chrome profile, browser ownership file, sessions,
exports, and configuration. Development never downloads or reuses the production
runtime; it executes the built files from this checkout.

## Switch lanes

From the repository root, enable the development lane:

```sh
pnpm codex:use-dev
```

This builds the checkout, generates an isolated local `rec-mcp-dev` plugin under
`~/.rec-dev`, registers its local `rec-dev` marketplace, removes the production
plugin, and installs the development plugin. Open a **new Codex task** after the
command finishes.

Return to production with:

```sh
pnpm codex:use-production
```

It removes only `rec-mcp-dev@rec-dev` and reinstalls `rec-mcp@rec`. It does not
delete `~/.rec-dev`, production sessions, or downloaded production runtimes.

Inspect the active lane and its paths with:

```sh
pnpm codex:status
```

To reclaim a lane's recordings or browser profile, stop its managed browser
first, inspect the exact directory, then remove only that lane's directory. The
switch commands deliberately never delete state.

## Production release process

A Git push is not a Rec release. Users receive a new runtime only after an
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

5. Publish the generated `.artifacts/rec-<version>-darwin-arm64.tar.gz` using
   the maintainer publishing token:

   ```sh
   REC_RELEASE_PUBLISH_TOKEN=<token> \
     node scripts/publish-release.mjs .artifacts/rec-<version>-darwin-arm64.tar.gz
   ```

   The release feed rejects attempts to replace an existing version/platform
   pair. Verify its exact metadata endpoint before updating the marketplace:

   ```text
   GET /v1/releases/<version>?platform=darwin-arm64
   ```

6. Copy `plugins/rec-mcp` into the plugin-only marketplace repository, commit
   and push it. The plugin's manifest version and both
   `REC_RUNTIME_VERSION` values must equal the released runtime version;
   `pnpm release:check` enforces the source-copy invariant.

7. Verify from an isolated runtime directory that the marketplace plugin
   downloads the published archive and that a fresh Codex task starts it.

8. Tell users to upgrade deliberately:

   ```sh
   codex plugin marketplace upgrade rec
   codex plugin add rec-mcp@rec
   ```

   They then open a new Codex task. The updated plugin requests exactly its own
   runtime version and installs it under `~/.rec/runtimes/<version>`.

## Upgrade and rollback behavior

Production plugins pin their runtime with `REC_RUNTIME_VERSION`. A plugin at
version `X.Y.Z` requests only runtime `X.Y.Z`; it does not silently adopt the
highest release in the feed. The old `/latest` endpoint remains available for
diagnostics and pre-pin plugins, but production plugins do not use it.

To roll back, republish neither the archive nor the same version—both are
immutable. Instead, restore the earlier plugin revision in the marketplace and
reinstall it. Its pin selects the previously published runtime, which remains in
the release feed and can be reused from the local runtime cache.
