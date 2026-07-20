# Changelog

Replay follows [Semantic Versioning](https://semver.org/). Each published runtime
is immutable and is named `replay-<version>-darwin-arm64.tar.gz`.

## [Unreleased]

- Add an OpenAI Responses API backend for the replay assistant with true
  token streaming, server-side conversation state, and direct tool calling.
  `chat.provider` selects it ("auto" prefers OpenAI when a key is configured,
  falling back to the Codex CLI).
- Add a replay assistant chat panel to the local player, powered by the Codex
  CLI. The assistant reads a distilled action timeline of the replay and can
  drive the player while it answers: seeking, pausing, highlighting elements,
  and reading the rendered page at any moment. Local-only; hidden on shared
  replays and configurable via the new `[chat]` config table.
- Add semantic replay summarization to core (`summarizeReplay`): navigations,
  clicks with element labels, typed input, tab switches, markers, and idle
  gaps distilled from the raw rrweb stream.

## [0.2.2] - 2026-07-18

- Pin each marketplace plugin to its matching immutable runtime release.
- Add isolated Codex development and production lanes with explicit switching.
- Add exact-version release feed metadata for validation and rollback.

## [0.2.1] - 2026-07-18

- Make published release artifacts immutable.
- Run the plugin bootstrap from its installed plugin directory.

## [0.2.0] - 2026-07-18

- Add a Codex plugin bootstrapper that installs the matching Replay runtime on
  first use.
- Add a versioned runtime release feed and protected release publishing API.
- Add the macOS runtime archive, checksum, and release-version guard.

## [0.1.0]

- Initial local replay, agent capture, portable artifacts, and replay sharing
  workflow.
