# Codex distribution

Replay is distributed to end users through an approved Codex marketplace, not as a
source checkout. The plugin includes a small bootstrapper; on first use it
downloads its pinned versioned macOS Apple-silicon runtime, verifies its
checksum, and starts Replay normally.

The marketplace should be a small, plugin-only Git repository. It contains the
marketplace catalog and `plugins/replay-mcp`, but never the Replay application source
or runtime archives. Codex supports Git-backed marketplace sources and caches
the installed plugin separately from the runtime.

To create that repository from this checkout, preserve the plugin directory
itself (not only its contents):

```sh
mkdir -p <plugin-marketplace>/plugins
cp -R /Users/mo/Documents/stitch/plugins/replay-mcp <plugin-marketplace>/plugins/replay-mcp
```

The marketplace catalog's `source.path` must remain `./plugins/replay-mcp`.

## User installation

Install **Replay browser replays** from the approved Codex marketplace. The
first task that uses its MCPs installs the runtime under
`~/.replay/runtimes/<version>` automatically. A new Codex task then has both Replay
and the shared Playwright launcher available. No archive, `pnpm install`,
source checkout, or manual MCP configuration is required.

Until Replay is accepted into a curated marketplace, the same workflow is one
terminal command from the private plugin marketplace repository:

```sh
codex plugin marketplace add <plugin-marketplace-git-url> && codex plugin add replay-mcp@replay
```

The initial release feed permits public reads so a Codex plugin can bootstrap
without asking users for credentials; publishing is protected by a maintainer
token. It serves compiled artifacts only, not the source checkout. Authenticated
downloads and stronger source-protection measures remain later hardening work.

## Versioning

Replay uses `MAJOR.MINOR.PATCH` Semantic Versioning. The root package is the
single source of truth; every deployable package and the Codex plugin must use
that exact version. `pnpm release:check` enforces the invariant and requires a
matching changelog entry. `pnpm release:version <version>` updates the version
fields together, then the release notes must be added before packaging.

The release feed publishes immutable archives by platform and version. A
production plugin requests the exact runtime version it was released with, so
users upgrade only after they update the marketplace plugin. The feed also has a
`latest` endpoint for diagnostics and older plugins, but it is not the normal
production upgrade path. See the [development and release lanes](development-and-releases.md)
for switching, validation, release, and rollback steps.

## Maintainer release build

On an Apple-silicon macOS release machine with the repository dependencies
available:

```sh
pnpm package:macos
```

This produces `.artifacts/replay-<version>-darwin-arm64.tar.gz` and its matching
`.sha256` checksum. Publish the archive with
`REPLAY_RELEASE_PUBLISH_TOKEN=<token> node scripts/publish-release.mjs <archive>`.
The hosted release feed stores immutable version/platform pairs and is what the
Codex bootstrapper reads. Before publishing, sign the archive and notarize the
embedded Node-based app bundle if required by the delivery channel.

## Scope and limitation

The archive avoids giving users the TypeScript source checkout and build tool
chain. It is not a cryptographic source-protection boundary: packaged JavaScript
can still be inspected by a determined recipient. A future hardened native
launcher can raise that bar, but code signing establishes provenance, not
secrecy.
