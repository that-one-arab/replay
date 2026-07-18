# Configuration

Rec reads TOML settings before it launches its managed Chrome or starts a
recording. Coding agents do not need configuration instructions in their prompts.

Put defaults in `~/.rec/config.toml`, project settings in
`<project>/.rec/config.toml`, or point `REC_CONFIG` at one additional file.

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
```

Settings merge per key in this order: built-in defaults, user file, project file,
`REC_CONFIG`, then the matching `REC_*` environment variable. Run
`pnpm rec config show` to see the effective configuration and its sources.

Browser settings are fixed for a running Rec-managed Chrome. After changing
`headless`, `viewport`, or `executable`, run `pnpm rec browser stop` and start a
fresh agent task. Rec will report `restart_required` rather than silently
interrupting a browser or a recording. External CDP attachments are never
reconfigured.

Replay defaults are copied into each new recording. Reviewers can still switch
between **Cut**, **8×**, and **Keep** in the player without changing the artifact.

## Local runtime lifecycle

Rec manages the local daemon and, when used, its dedicated Chrome separately.
The MCP server and Playwright launcher hold an **agent lease** while they are
alive. When the final agent lease ends, Rec waits 30 seconds before stopping
only its managed Chrome. A locally open replay holds a **replay lease**, keeping
the daemon available without retaining Chrome.

With neither kind of lease, the daemon exits after 15 minutes. Override either
grace period in milliseconds when needed:

```sh
REC_BROWSER_IDLE_TIMEOUT_MS=60000
REC_DAEMON_IDLE_TIMEOUT_MS=1800000
```

Both values must be at least 1000 ms. An active recording prevents automatic
shutdown. Use `rec daemon stop` to end the daemon immediately once recording
has stopped.
