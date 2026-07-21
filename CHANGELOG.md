# Changelog

Replay follows [Semantic Versioning](https://semver.org/). Each published runtime
is immutable and is named `replay-<version>-darwin-arm64.tar.gz`.

## [Unreleased]

## [0.3.0] - 2026-07-22

- Make share links agent-readable (phase 4B, layer 1): `GET /r/<id>.md`
  returns a prompt-ready markdown summary of the shared replay (timeline,
  markers, agent actions with failures highlighted), `GET /r/<id>.json`
  returns the structured summary, and a client that prefers `text/markdown`
  gets the summary from the bare share link instead of the player redirect.
  Summaries are cached per share and identify the replay by share id only.
  Upload responses and the share tools now also return `summaryUrl`.
- Add a scoped remote query API for shared replays (phase 4B, layer 2):
  `GET /v1/replays/:shareId/{summary,steps,actions,markers,bundle}`, keyed by
  share id only. Shares gain a `revoked` flag that 404s the link everywhere,
  including the player's session data routes; re-uploading a revoked replay
  mints a fresh link.
- Add remote-read MCP tools (phase 4B, layer 3): `replay_overview` and
  `replay_steps` read a shared replay from its pasted link with no
  configuration, and `replay_fetch` imports the shared bundle into the local
  Replay home for deep inspection in the local player.
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

## [0.2.3] - 2026-07-21

- Suppress action-bound markers on failed actions so a retried step no longer
  produces duplicate chapters.
- Fix `__replayResolveNodeId` (missing brace) so text-based highlight resolution
  pins the element instead of silently returning null.
- Guide agents (SKILL) to mark only successful actions and not re-mark retries.
- Bake `REPLAY_SHARE_URL` into the installer's printed `mcp add` commands.

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
