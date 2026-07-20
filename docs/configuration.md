# Configuration

Replay reads TOML settings before it launches its managed Chrome or starts a
replay. Coding agents do not need configuration instructions in their prompts.

Put defaults in `~/.replay/config.toml`, project settings in
`<project>/.replay/config.toml`, or point `REPLAY_CONFIG` at one additional file.

```toml
[browser]
# Set true for unattended agent runs. Chrome still runs locally; its window is hidden.
headless = true
viewport = "1280x720"
# executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[replay]
# "cut", "fast_forward", or "preserve"
idle_mode = "cut"
idle_retained_ms = 2000
idle_fast_forward_speed = 8
default_speed = 1.15

[chat]
# The replay assistant in the local player.
enabled = true
# "auto" uses the OpenAI API when a key is available, else the Codex CLI.
provider = "auto"
command = "codex"
# model = "gpt-5.6-terra"
# api_key = "sk-…"   # or set OPENAI_API_KEY / REPLAY_CHAT_API_KEY
```

Settings merge per key in this order: built-in defaults, user file, project file,
`REPLAY_CONFIG`, then the matching `REPLAY_*` environment variable. Run
`pnpm replay config show` to see the effective configuration and its sources.

Browser settings are fixed for a running Replay-managed Chrome. After changing
`headless`, `viewport`, or `executable`, run `pnpm replay browser stop` and start a
fresh agent task. Replay will report `restart_required` rather than silently
interrupting a browser or a replay. External CDP attachments are never
reconfigured.

Replay defaults are copied into each new replay. Reviewers can still switch
between **Cut**, **8×**, and **Keep** in the player without changing the artifact.

## Replay assistant

The local player includes an **Ask AI** panel with two interchangeable
backends. It is local-only either way: shared replays never show the panel,
and nothing about the replay is sent anywhere except to the model provider
you configured.

- **OpenAI API** (preferred when a key is available): the daemon calls the
  Responses API directly, streams tokens as they arrive, and keeps the
  conversation in an OpenAI Conversations object. Supply a key via
  `chat.api_key`, `OPENAI_API_KEY`, or `REPLAY_CHAT_API_KEY`. The default model
  is `gpt-5.6-terra`; override it with `chat.model`.
- **Codex CLI**: the daemon runs `codex exec` using your existing Codex
  sign-in — no key needed. `chat.command` points at a specific binary.

`chat.provider` chooses explicitly (`"openai"` or `"codex"`); the default
`"auto"` picks OpenAI when a key is configured and Codex otherwise. Set
`chat.enabled = false` (or `REPLAY_CHAT_ENABLED=false`) to remove the panel
entirely. The matching environment variables are `REPLAY_CHAT_ENABLED`,
`REPLAY_CHAT_PROVIDER`, `REPLAY_CHAT_COMMAND`, `REPLAY_CHAT_MODEL`, and
`REPLAY_CHAT_API_KEY`. If the chosen backend is missing its CLI or key, the panel
explains how to set it up instead of failing silently.

## Local runtime lifecycle

Replay manages the local daemon and, when used, its dedicated Chrome separately.
The MCP server and Playwright launcher hold an **agent lease** while they are
alive. When the final agent lease ends, Replay waits 30 seconds before stopping
only its managed Chrome. A locally open replay holds a **replay lease**, keeping
the daemon available without retaining Chrome.

With neither kind of lease, the daemon exits after 15 minutes. Override either
grace period in milliseconds when needed:

```sh
REPLAY_BROWSER_IDLE_TIMEOUT_MS=60000
REPLAY_DAEMON_IDLE_TIMEOUT_MS=1800000
```

Both values must be at least 1000 ms. An active replay prevents automatic
shutdown. Use `replay daemon stop` to end the daemon immediately once replay
has stopped.
