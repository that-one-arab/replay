# Codex distribution

Rec is distributed to end users as a versioned macOS Apple-silicon archive, not
as a source checkout. The archive contains a private Node runtime, Rec's
compiled runtime payload, the Codex plugin, and `install.sh`.

## User installation

Download the approved `rec-<version>-darwin-arm64.tar.gz` release, unpack it,
then run its installer:

```sh
tar -xzf rec-<version>-darwin-arm64.tar.gz
./rec-<version>-darwin-arm64/install.sh
```

The installer places the runtime in `~/.rec/runtimes/<version>`, preserves the
previous plugin as a timestamped backup, configures the bundled Codex plugin,
and asks Codex to install it. A new Codex task then has both Rec and the shared
Playwright launcher available. No `pnpm install`, source checkout, or manual
MCP configuration is required.

The release is designed for a private, authenticated artifact channel. Do not
publish a release archive to a public source repository when source visibility
matters. The release service and signing identity are intentionally separate
from this repository.

## Maintainer release build

On an Apple-silicon macOS release machine with the repository dependencies
available:

```sh
pnpm package:macos
```

This produces `.artifacts/rec-<version>-darwin-arm64.tar.gz` and its matching
`.sha256` checksum. Before upload, the release process must sign the archive,
notarize the embedded Node-based app bundle if required by the chosen delivery
channel, and upload the archive, checksum, and signature to the private
artifact service.

## Scope and limitation

The archive avoids giving users the TypeScript source checkout and build tool
chain. It is not a cryptographic source-protection boundary: packaged JavaScript
can still be inspected by a determined recipient. A future hardened native
launcher can raise that bar, but code signing establishes provenance, not
secrecy.
