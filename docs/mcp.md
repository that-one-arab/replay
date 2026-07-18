# Agent-native recording MCP server

`rec-mcp` is a local stdio MCP server. It gives an MCP-capable coding agent seven
structured tools instead of requiring it to parse the `rec` CLI's terminal output.
It never exposes the recorder beyond the local machine.

| Tool | Purpose |
| --- | --- |
| `recording_browser_ensure` | Launches or reuses Rec's configured dedicated Chrome and returns its CDP endpoint. |
| `recording_attach_browser` | Attaches Rec to an explicitly supplied loopback CDP endpoint; Rec never stops that external browser. |
| `recording_start` | Starts a recording on an attached browser, but only after a navigated in-scope page exists. |
| `recording_marker` | Adds an optional labelled checkpoint to the active recording. |
| `recording_status` | Returns browser ownership, endpoint, page readiness, and active capture counts. |
| `recording_stop` | Stops capture and returns its ID, local bundle details, portable artifact path, and replay URL. With `REC_SHARE_URL`, it also publishes automatically and returns `shareUrl`; `shareError` preserves the local handoff if upload fails. |
| `recording_share` | Explicitly uploads a stopped recording to `REC_SHARE_URL` and returns its public bearer link. |

## Two-server workflow

Rec records a browser; it does not drive it. The Codex plugin starts stock
Playwright MCP through Rec's stdio-transparent launcher. The launcher ensures the
shared browser before Playwright starts, so a user can ask an agent to browse first
and record later without mentioning a browser, port, or recording workflow.

1. Use Playwright MCP to navigate to the target application and inspect its initial state.
2. Call `recording_start` when a recording is requested.
3. Use Playwright MCP for every click, fill, wait, and tab action.
4. Add `recording_marker` only for meaningful, confirmed checkpoints.
5. Call `recording_stop` and use its `shareUrl` when configured, otherwise its local `replayUrl`.

Do not drive Web Preview, Arc, Codex's in-app browser, or an arbitrary normal Chrome
session while expecting Rec to capture it. For a standalone MCP client, configure
the two servers as follows:

```toml
[mcp_servers.playwright]
command = "node"
args = ["/absolute/path/to/rec/packages/playwright-launcher/dist/main.js"]

[mcp_servers.rec]
command = "node"
args = ["/absolute/path/to/rec/packages/mcp/dist/main.js"]
```

The launcher invokes the user-installed stock `@playwright/mcp` package with the
Rec-managed CDP endpoint. It forwards its stdio unchanged and never proxies or
implements Playwright tools. By default it runs `npx -y @playwright/mcp@latest`;
set `REC_PLAYWRIGHT_MCP_COMMAND` and `REC_PLAYWRIGHT_MCP_ARGS` (a JSON string
array) to use a pinned or locally installed Playwright command instead.

Rec reads browser and replay defaults from its [configuration](configuration.md).
If a managed browser’s headless mode, viewport, or executable no longer matches,
`recording_browser_ensure` and `recording_status` report `restart_required`;
stop that managed browser and start a fresh task. The agent does not need a
configuration tool or prompt-level recording settings.

`recording_start` rejects an empty browser with guidance to navigate first;
`recording_stop` rejects an empty capture instead of returning a misleading replay
link. The recorder's existing password masking remains enabled; broader masking
policy is intentionally deferred to a later phase.

Markers are ordered narrative metadata, not Playwright action IDs. Their optional
`placement` defaults to `after_previous` for a confirmed result, while
`before_next` denotes a precondition or chapter boundary before the next browser
action. Never issue a Playwright action and a Rec marker in parallel.

## Standalone setup

Build the repository, then configure any MCP client to launch the server over
stdio. Substitute this checkout's absolute path:

```json
{
  "mcpServers": {
    "rec": {
      "command": "node",
      "args": ["/absolute/path/to/rec/packages/mcp/dist/main.js"]
    }
  }
}
```

Set `REC_DAEMON_URL` only when the daemon is intentionally running somewhere
other than `http://127.0.0.1:7717`. The MCP server starts the daemon on demand.

## Codex plugin

The local `rec-mcp` Codex plugin starts both Rec MCP and the Playwright launcher.
It is deliberately local-only: installation adds no hosted service, credentials,
or sharing capability. Playwright remains an independent package; the launcher
only starts it after establishing Rec's shared browser.
