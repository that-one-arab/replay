# `@signit/rec-cli`

The developer and troubleshooting command-line interface. Its executable is
`rec`; from this repository, run it as `pnpm rec <command>`.

The normal coding-agent workflow uses Rec MCP and Playwright MCP, not this CLI.
Use the CLI to inspect local state, work directly with portable artifacts, or
recover a share upload.

## Commands

### `rec browser start [--executable <path>]`

Launch or reuse Rec’s managed local Chrome and print its CDP endpoint.

- `--executable <path>` overrides the configured Chrome executable for this
  launch. It is mainly useful for troubleshooting.

The managed browser otherwise uses [Rec configuration](../../docs/configuration.md).
It is the Chrome Playwright must drive for a Rec recording.

### `rec browser stop`

Stop Rec’s managed Chrome. It refuses to stop while a recording is active and
never stops an externally attached browser. Use it after changing `headless`,
`viewport`, or `executable` configuration, then start a fresh agent task.

### `rec attach --cdp <loopback-url>`

Attach Rec to an existing local Chrome debugging endpoint, for example:

```sh
pnpm rec attach --cdp http://127.0.0.1:9222
```

Only loopback endpoints are accepted. Rec treats this browser as external and
will not stop or reconfigure it.

### `rec start [options]`

Start recording the currently attached browser after it has navigated to an
in-scope page.

- `--title <text>` sets the recording title.
- `--origin <origin>` sets an allowed page origin. Repeat the option for more
  than one origin. Without it, Rec uses the active page’s origin.
- `--mask-all-inputs` masks all input text. Password inputs are always masked.
- `--record-canvas` captures canvas mutations. This is opt-in because it may
  increase bundle size and capture sensitive pixels.

Example:

```sh
pnpm rec start --title "Checkout failure" --origin http://127.0.0.1:5173 --mask-all-inputs
```

### `rec marker <label> [options]`

Add a checkpoint to the active recording.

- `--note <text>` adds reviewer context.
- `--placement after_previous|before_next` describes whether the marker
  narrates the confirmed preceding action or the next action. Defaults to
  `after_previous`.

### `rec stop [options]`

Stop the active recording, finalize its manifest, and create the default
portable artifact under `~/.rec/exports/` (or `REC_HOME/exports/`).

- `--outcome reproduced|verified|other` records the terminal outcome.
- `--notes <text>` stores concise handoff notes in the manifest.

It prints the local replay URL. The CLI does not automatically publish to a
share service; that automatic behavior belongs to MCP `recording_stop`.

### `rec status`

Print the active recording’s local status. This starts the daemon if needed.

### `rec list`

List locally stored recordings with their active and wall-clock durations,
outcome, and title.

### `rec open <session-id>`

Print the local replay URL for an existing session. It does not open a browser.

### `rec export <session-id> [--output <file.rec>]`

Create a gzip-compressed, verified portable artifact. Without `--output`, Rec
writes to `~/.rec/exports/<session-id>.rec` (or `REC_HOME/exports/`). Existing
output files are never overwritten.

### `rec import <file.rec>`

Verify and install a portable artifact, then print its local replay URL. Rec
rejects invalid data and never overwrites an existing session ID.

### `rec share <session-id>`

Upload a completed recording to the configured share service and print its
public bearer link. Set `REC_SHARE_URL` first:

```sh
REC_SHARE_URL=https://<your-service-domain> pnpm rec share rec_12345678
```

If its default artifact is absent, this command exports it first. This is a
manual recovery path; agents normally receive a share link from `recording_stop`.

### `rec config show`

Print effective browser and replay configuration, the files that contributed to
it, and unknown-key warnings.

### `rec doctor`

Print daemon availability, browser attachment, Rec spool location, and
configuration diagnostics. It is the first command to run when setup does not
behave as expected.

## Environment

- `REC_HOME` changes the session, export, and managed-browser directory.
- `REC_DAEMON_URL` targets an intentionally separate local daemon. Default:
  `http://127.0.0.1:7717`.
- `REC_SHARE_URL` enables `rec share`.
- `REC_CONFIG` selects an additional Rec TOML file.

Browser and replay-specific `REC_*` variables are documented in the
[configuration guide](../../docs/configuration.md).
