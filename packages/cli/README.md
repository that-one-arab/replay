# `@replay/cli`

The developer and troubleshooting command-line interface. Its executable is
`replay`; from this repository, run it as `pnpm replay <command>`.

The normal coding-agent workflow uses Replay MCP and Playwright MCP, not this CLI.
Use the CLI to inspect local state, work directly with portable artifacts, or
recover a share upload.

## Commands

### `replay browser start [--executable <path>]`

Launch or reuse Replay’s managed local Chrome and print its CDP endpoint.

- `--executable <path>` overrides the configured Chrome executable for this
  launch. It is mainly useful for troubleshooting.

The managed browser otherwise uses [Replay configuration](../../docs/configuration.md).
It is the Chrome Playwright must drive for a replay.

### `replay browser stop`

Stop capturing’s managed Chrome. It refuses to stop while a capture is active and
never stops an externally attached browser. Use it after changing `headless`,
`viewport`, or `executable` configuration, then start a fresh agent task.

### `replay daemon stop`

Stop the local daemon and its Replay-managed Chrome. It refuses while a replay
is active. This is an explicit escape hatch; in normal use the daemon releases
the browser after its agent lease expires and exits after its idle timeout.

### `replay attach --cdp <loopback-url>`

Attach Replay to an existing local Chrome debugging endpoint, for example:

```sh
pnpm replay attach --cdp http://127.0.0.1:9222
```

Only loopback endpoints are accepted. Replay treats this browser as external and
will not stop or reconfigure it.

### `replay start [options]`

Start capturing the currently attached browser after it has navigated to an
in-scope page.

- `--title <text>` sets the replay title.
- `--origin <origin>` sets an allowed page origin. Repeat the option for more
  than one origin. Without it, Replay uses the active page’s origin.
- `--mask-all-inputs` masks all input text. Password inputs are always masked.
- `--capture-canvas` captures canvas mutations. This is opt-in because it may
  increase bundle size and capture sensitive pixels.

Example:

```sh
pnpm replay start --title "Checkout failure" --origin http://127.0.0.1:5173 --mask-all-inputs
```

### `replay marker <label> [options]`

Add a checkpoint to the active replay.

- `--note <text>` adds reviewer context.
- `--placement after_previous|before_next` describes whether the marker
  narrates the confirmed preceding action or the next action. Defaults to
  `after_previous`.

### `replay stop [options]`

Stop the active replay, finalize its manifest, and create the default
portable artifact under `~/.replay/exports/` (or `REPLAY_HOME/exports/`).

- `--outcome reproduced|verified|other` captures the terminal outcome.
- `--notes <text>` stores concise handoff notes in the manifest.

It prints the local replay URL. The CLI does not automatically publish to a
share service; that automatic behavior belongs to MCP `capture_stop`.

### `replay status`

Print the active replay’s local status. This starts the daemon if needed.

### `replay list`

List locally stored replays with their active and wall-clock durations,
outcome, and title.

### `replay open <session-id>`

Print the local replay URL for an existing session. It does not open a browser.

### `replay export <session-id> [--output <file.replay>]`

Create a gzip-compressed, verified portable artifact. Without `--output`, Replay
writes to `~/.replay/exports/<session-id>.replay` (or `REPLAY_HOME/exports/`). Existing
output files are never overwritten.

### `replay import <file.replay>`

Verify and install a portable artifact, then print its local replay URL. Replay
rejects invalid data and never overwrites an existing session ID.

### `replay share <session-id>`

Upload a completed replay to the configured share service and print its
public bearer link. Set `REPLAY_SHARE_URL` first:

```sh
REPLAY_SHARE_URL=https://<your-service-domain> pnpm replay share replay_12345678
```

If its default artifact is absent, this command exports it first. This is a
manual recovery path; agents normally receive a share link from `capture_stop`.

### `replay config show`

Print effective browser and replay configuration, the files that contributed to
it, and unknown-key warnings.

### `replay doctor`

Print daemon availability, browser attachment, Replay spool location, and
configuration diagnostics. It is the first command to run when setup does not
behave as expected.

## Environment

- `REPLAY_HOME` changes the session, export, and managed-browser directory.
- `REPLAY_DAEMON_URL` targets an intentionally separate local daemon. Default:
  `http://127.0.0.1:7717`.
- `REPLAY_SHARE_URL` enables `replay share`.
- `REPLAY_CONFIG` selects an additional Replay TOML file.
- `REPLAY_BROWSER_IDLE_TIMEOUT_MS` controls how long Replay keeps its managed Chrome
  after the last agent lease (default: 30 seconds).
- `REPLAY_DAEMON_IDLE_TIMEOUT_MS` controls how long Replay keeps the local daemon
  after all agent and replay leases end (default: 15 minutes).

Browser and replay-specific `REPLAY_*` variables are documented in the
[configuration guide](../../docs/configuration.md).
