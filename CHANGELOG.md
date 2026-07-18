# Changelog

Rec follows [Semantic Versioning](https://semver.org/). Each published runtime
is immutable and is named `rec-<version>-darwin-arm64.tar.gz`.

## [0.2.2] - 2026-07-18

- Pin each marketplace plugin to its matching immutable runtime release.
- Add isolated Codex development and production lanes with explicit switching.
- Add exact-version release feed metadata for validation and rollback.

## [0.2.1] - 2026-07-18

- Make published release artifacts immutable.
- Run the plugin bootstrap from its installed plugin directory.

## [0.2.0] - 2026-07-18

- Add a Codex plugin bootstrapper that installs the matching Rec runtime on
  first use.
- Add a versioned runtime release feed and protected release publishing API.
- Add the macOS runtime archive, checksum, and release-version guard.

## [0.1.0]

- Initial local recording, agent capture, portable artifacts, and replay sharing
  workflow.
