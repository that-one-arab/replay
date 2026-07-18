# Rec configuration plan

## Status

Implemented. The first configuration release covers the typed TOML loader,
browser launch settings, replay defaults persisted in recordings, the player’s
three idle modes, CLI diagnostics, and agent/launcher integration.

## Objective

Let a developer configure Rec once and have those preferences apply consistently
to Codex and other MCP-capable coding agents. Configuration must not require
agents to repeat browser or replay instructions in each prompt.

Initial settings in scope:

- Launch Rec's managed browser headlessly or headed.
- Choose the default replay treatment of inactive time: cut it, fast-forward it,
  or keep it in real time.
- Configure the retained duration for a cut idle interval, the fast-forward
  multiplier, and the default playback speed.

The configuration system should be Rec-owned, rather than tied to Codex's
configuration format or to one MCP client.

## Product decisions

| Area | Decision |
| --- | --- |
| Canonical format | TOML, because it is readable, comment-friendly, and already familiar to Codex users. |
| User defaults | `~/.rec/config.toml`. |
| Project defaults | `<project>/.rec/config.toml`, discovered only from the MCP process working directory. Do not walk ancestor directories. |
| Explicit config | `REC_CONFIG=/absolute/path/to/config.toml` selects one additional explicit file. |
| Agent integration | Rec MCP and the Playwright launcher read resolved Rec configuration automatically. Agents do not need to mention options in prompts. |
| Browser ownership | Browser launch settings are fixed for a running managed browser. Rec never silently relaunches a browser to apply a changed setting. |
| Replay defaults | Store resolved replay defaults in each recording manifest at `recording_start`, so the intended behavior travels with a future exported artifact. |
| UI controls | The player retains user controls. Configuration supplies initial values, not a locked policy. |

## Configuration model

```toml
# ~/.rec/config.toml or <project>/.rec/config.toml

[browser]
# Show Rec's dedicated Chrome window. Defaults to false for local interactive use.
headless = false
# Fixed browser viewport used when headless. Defaults: 1280 × 720.
viewport = "1280x720"
# Optional path to a Chrome-compatible executable.
# executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[replay]
# "cut" removes most inactive time, "fast_forward" preserves it at a higher
# rate, and "preserve" leaves timing unchanged.
idle_mode = "cut"
# Time retained from each idle range when idle_mode is "cut".
idle_retained_ms = 2000
# Multiplier used only when idle_mode is "fast_forward".
idle_fast_forward_speed = 8
# Initial non-idle player speed.
default_speed = 1.15
```

Defaults should preserve the current product behavior:

```toml
[browser]
headless = false
viewport = "1280x720"

[replay]
idle_mode = "cut"
idle_retained_ms = 2000
idle_fast_forward_speed = 8
default_speed = 1.15
```

`idle_mode` is intentionally one enum rather than two booleans. It prevents
ambiguous combinations such as cutting and fast-forwarding the same idle range.

## Precedence and validation

Resolve individual keys in this order, from highest to lowest priority:

1. An explicit MCP or CLI argument, where that interface intentionally exposes
   the setting.
2. A corresponding `REC_*` environment variable for automation and debugging.
3. `REC_CONFIG`, when it names an explicit configuration file.
4. `<project>/.rec/config.toml`.
5. `~/.rec/config.toml`.
6. Built-in defaults.

The exact environment names should be narrow and documented:

```text
REC_BROWSER_HEADLESS
REC_BROWSER_VIEWPORT
REC_BROWSER_EXECUTABLE
REC_REPLAY_IDLE_MODE
REC_REPLAY_IDLE_RETAINED_MS
REC_REPLAY_IDLE_FAST_FORWARD_SPEED
REC_REPLAY_DEFAULT_SPEED
```

Rules:

- Unknown TOML keys generate a warning in `rec doctor` and diagnostics, but do
  not prevent startup. This makes forward-compatible shared project files safe.
- Invalid values fail before a browser launches, with the file path and key in
  the error. Do not silently fall back for an invalid selected configuration.
- Accept only `headless = true|false`; a viewport must be `WIDTHxHEIGHT`; speeds
  and durations must be finite positive numbers; `idle_mode` must be one of the
  documented enum values.
- Configuration values must never be recorded as sensitive event data. The
  resolved non-sensitive replay defaults may be persisted in a manifest.

## Browser launch behavior

Rec's daemon is the sole owner of managed browser launch options.

1. The daemon resolves configuration when `recording_browser_ensure` or the
   Playwright launcher requests a browser.
2. It launches Chrome with its normal remote-debugging arguments and, when
   configured, `--headless=new` plus the configured viewport.
3. It returns the same loopback CDP endpoint to the launcher and Rec MCP.
4. Stock Playwright MCP attaches through that endpoint exactly as it does today.

Headless mode hides the Chrome window; it does not remove the local browser
process. rrweb capture, semantic cursor playback, markers, tabs, and replay must
remain identical in both modes.

If a managed browser already exists, compare the requested browser launch
settings to the settings recorded in `browser.json`:

- If they match, reuse the browser.
- If they differ and no recording is active, return a status field such as
  `browserConfigState: "restart_required"` and actionable guidance to run
  `rec browser stop` before ensuring again.
- If a recording is active, return the same state without changing the browser.

Never terminate an external browser attached with `recording_attach_browser`.
Its launch options are informationally unavailable and must not be treated as a
configuration mismatch.

## Replay behavior and manifest metadata

The raw event stream must always retain original timestamps. Idle handling stays
a player transformation, preserving the ability to seek accurately and to switch
between modes after recording.

At `recording_start`, add a versioned manifest field, for example:

```json
{
  "replay_defaults": {
    "idle_mode": "cut",
    "idle_retained_ms": 2000,
    "idle_fast_forward_speed": 8,
    "default_speed": 1.15
  }
}
```

Older manifests omit this field and receive today's hard-coded defaults.

On replay load:

1. Read the recording's `replay_defaults`.
2. Initialize the timeline transform and speed control from those values.
3. Let the viewer switch modes or speed for the current viewing session.
4. Do not mutate the source manifest merely because a viewer changes controls.

This preserves author intent for portable recordings while allowing a reviewer to
inspect original pacing when needed.

## Player UX

Replace any binary idle toggle with one explicit control:

```text
Idle: Cut | 8× | Keep
```

- **Cut** is the default and compresses an idle range to `idle_retained_ms`.
- **8×** retains the range but advances it at the configured multiplier. The
  label reflects the configured multiplier rather than assuming eight forever.
- **Keep** uses original timing.

The timeline continues to visually mark idle ranges in every mode. Its label
should explain the active treatment, for example `Idle reduced from 13s to 2s`
or `Idle played at 8×`.

Changing modes must preserve the equivalent raw timeline location and the prior
play/pause state. It must not unexpectedly pause playback, change the selected
recorded tab, or lose keyboard controls.

## MCP and CLI surface

Keep agent tool calls minimal.

- `recording_browser_ensure` reads the resolved browser configuration. It may
  return `headless`, viewport, and `browserConfigState` as diagnostics.
- `recording_status` exposes the resolved and active browser configuration so an
  agent can explain a restart-required state.
- `recording_start` stores resolved replay defaults. It does not need replay
  parameters in normal agent prompts.
- The CLI gains `rec config show` for effective configuration and source paths,
  and `rec doctor` reports parse errors, shadowed files, and browser restart
  requirements.

Do not add a broad configuration MCP tool in the first iteration. Configuration
is a developer/runtime concern, not an action an agent should change casually
mid-task.

## Implementation work packages

### 1. Configuration loader and schema

- Add a small TOML parser dependency or a narrow parser with schema validation.
- Implement file discovery, explicit config handling, environment overrides,
  source-aware diagnostics, and a typed `ResolvedRecConfig` object.
- Unit-test every precedence level, invalid value, unknown key warning, and
  absence of configuration files.

### 2. Browser lifecycle integration

- Replace hard-coded managed-browser launch arguments with resolved settings.
- Extend `browser.json` with a configuration fingerprint and active settings.
- Detect settings mismatches without restarting or taking over external Chrome.
- Add status/ensure diagnostics and CLI guidance.

### 3. Recording metadata

- Extend the recording manifest type and storage validation with
  `replay_defaults`.
- Persist the resolved replay defaults at recording start.
- Maintain read compatibility for old manifests.

### 4. Player timeline modes

- Generalize current idle compaction into a transform selected by `idle_mode`.
- Implement fast-forward and preserve modes without changing raw timestamps.
- Add the three-way control, timeline labels, and retained idle highlighting.
- Preserve raw seek position, selected tab, autoplay state, and global keyboard
  shortcuts while switching modes.

### 5. Documentation and usability

- Document user, project, and explicit configuration files in the README and
  `docs/mcp.md`.
- Explain headless mode as invisible local Chrome, not browserless automation.
- Add configuration examples for interactive debugging and unattended agent use.
- Document `rec config show` and restart-required behavior.

## Validation

Run locally; do not add CI as part of this work.

### Configuration resolution

- Empty environment uses built-in defaults.
- User config applies when no project config exists.
- Project config overrides user config only for keys it specifies.
- `REC_CONFIG`, environment values, and explicit CLI/MCP values each override
  lower layers without erasing unrelated keys.
- Malformed TOML and invalid values fail with a helpful source location.

### Browser lifecycle

- Headed and headless managed Chrome both attach successfully over CDP.
- Stock Playwright MCP drives the same browser in both modes.
- A changed headless or viewport setting reports restart-required; it never
  interrupts an active recording.
- External CDP attachments remain untouched.

### Replay

- A capture made with each idle mode preserves events, markers, reload context,
  multi-tab lifecycle, and replay assets.
- Cut mode retains the configured duration, fast-forward uses the configured
  multiplier, and keep mode preserves wall-clock time.
- Switching modes during play, pause, seek, and near the end preserves the
  equivalent raw position and control state.
- Older recordings still open with the current built-in defaults.

### Human acceptance

1. Set `headless = true` in a project config.
2. Start a fresh Codex task and ask for a reproduction recording without any
   mention of browser setup.
3. Confirm no browser window appears, a real replay is returned, and the replay
   opens with the configured idle mode.
4. Change browser configuration, confirm Rec requests an explicit restart, then
   restart and verify the new configuration takes effect.

## Deferred

- Broader input-masking policy and secrets management.
- Per-agent or per-user authorization to change configuration.
- Hosted synchronization of configuration or replay preferences.
- Arbitrary browser discovery and reconfiguration of externally attached Chrome.
- Recording-specific overrides supplied by natural-language agent prompts.
