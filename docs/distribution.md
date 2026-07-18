# Codex distribution

Rec is distributed to end users through an approved Codex marketplace, not as a
source checkout. The plugin includes a small bootstrapper; on first use it
downloads the matching versioned macOS Apple-silicon runtime, verifies its
checksum, and starts Rec normally.

The marketplace should be a small, plugin-only Git repository. It contains the
marketplace catalog and `plugins/rec-mcp`, but never the Rec application source
or runtime archives. Codex supports Git-backed marketplace sources and caches
the installed plugin separately from the runtime.

To create that repository from this checkout, preserve the plugin directory
itself (not only its contents):

```sh
mkdir -p <plugin-marketplace>/plugins
cp -R /Users/mo/Documents/stitch/plugins/rec-mcp <plugin-marketplace>/plugins/rec-mcp
```

The marketplace catalog's `source.path` must remain `./plugins/rec-mcp`.

## User installation

Install **Rec browser recordings** from the approved Codex marketplace. The
first task that uses its MCPs installs the runtime under
`~/.rec/runtimes/<version>` automatically. A new Codex task then has both Rec
and the shared Playwright launcher available. No archive, `pnpm install`,
source checkout, or manual MCP configuration is required.

Until Rec is accepted into a curated marketplace, the same workflow is one
terminal command from the private plugin marketplace repository:

```sh
codex plugin marketplace add <plugin-marketplace-git-url> && codex plugin add rec-mcp@rec
```

The initial release feed permits public reads so a Codex plugin can bootstrap
without asking users for credentials; publishing is protected by a maintainer
token. It serves compiled artifacts only, not the source checkout. Authenticated
downloads and stronger source-protection measures remain later hardening work.

## Versioning

Rec uses `MAJOR.MINOR.PATCH` Semantic Versioning. The root package is the
single source of truth; every deployable package and the Codex plugin must use
that exact version. `pnpm release:check` enforces the invariant and requires a
matching changelog entry. `pnpm release:version <version>` updates the version
fields together, then the release notes must be added before packaging.

The release feed publishes immutable archives by platform and version. A client
requests its current platform and receives the highest available version; once
installed, the runtime remains pinned until a newer plugin session requests the
feed again.

## Maintainer release build

On an Apple-silicon macOS release machine with the repository dependencies
available:

```sh
pnpm package:macos
```

This produces `.artifacts/rec-<version>-darwin-arm64.tar.gz` and its matching
`.sha256` checksum. Publish the archive with
`REC_RELEASE_PUBLISH_TOKEN=<token> node scripts/publish-release.mjs <archive>`.
The hosted release feed stores immutable version/platform pairs and is what the
Codex bootstrapper reads. Before publishing, sign the archive and notarize the
embedded Node-based app bundle if required by the delivery channel.

## Scope and limitation

The archive avoids giving users the TypeScript source checkout and build tool
chain. It is not a cryptographic source-protection boundary: packaged JavaScript
can still be inspected by a determined recipient. A future hardened native
launcher can raise that bar, but code signing establishes provenance, not
secrecy.
