# Agent-native recording MCP server

`rec-mcp` is a local stdio MCP server. It gives an MCP-capable coding agent one
place to drive and record a browser: the stock Playwright MCP browser tools
(embedded from a pinned `@playwright/mcp`) plus seven structured recording
tools. It never exposes the recorder beyond the local machine.

| Tool | Purpose |
| --- | --- |
| `browser_*` (embedded) | The stock Playwright MCP tool surface, unchanged, driving Rec's shared Chrome. Every browser tool accepts an optional `rec_marker` checkpoint. |
| `recording_browser_ensure` | Launches or reuses Rec's configured dedicated Chrome and returns its CDP endpoint. |
| `recording_attach_browser` | Attaches Rec to an explicitly supplied loopback CDP endpoint; Rec never stops that external browser. |
| `recording_start` | Starts a recording on an attached browser, but only after a navigated in-scope page exists. |
| `recording_marker` | Adds a labelled checkpoint that belongs to no single browser action. |
| `recording_status` | Returns browser ownership, endpoint, page readiness, and active capture counts. |
| `recording_stop` | Stops capture and returns its ID, local bundle details, portable artifact path, and replay URL. With `REC_SHARE_URL`, it also publishes automatically and returns `shareUrl`; `shareError` preserves the local handoff if upload fails. |
| `recording_share` | Explicitly uploads a stopped recording to `REC_SHARE_URL` and returns its public bearer link. |

## Single-server workflow

Rec embeds the stock Playwright MCP in-process, so the agent configures one
server and the browser it drives is always the browser Rec records. The shared
Chrome is provisioned just-in-time on the first browser tool call; a user can
ask an agent to browse first and record later without mentioning a browser,
port, or recording workflow.

1. Use the `browser_*` tools to navigate to the target application and inspect its initial state.
2. Call `recording_start` when a recording is requested.
3. Keep using the `browser_*` tools for every click, fill, wait, and tab action.
4. Pass `rec_marker` on a browser action to checkpoint it; use `recording_marker` only for action-less checkpoints.
5. Call `recording_stop` and use its `shareUrl` when configured, otherwise its local `replayUrl`.

Do not drive Web Preview, Arc, Codex's in-app browser, or an arbitrary normal
Chrome session while expecting Rec to capture it. Do not configure a second
Playwright MCP entry alongside Rec: the agent would see duplicate `browser_*`
tools, and actions sent to the duplicate are neither recorded nor markable.

## Markers and actions

Every embedded browser tool accepts an optional `rec_marker` parameter:

```json
{ "name": "browser_click", "arguments": {
  "selector": "#submit",
  "rec_marker": { "label": "Submitted signup form", "note": "confirmed by toast" }
} }
```

Rec strips `rec_marker` before the call reaches Playwright and records the
checkpoint atomically with the action: same request, same identity. The
recording's manifest logs every browser action with its request/response
bracket, and an action-bound marker anchors on its own action in the player —
there is no ordering between servers to get right and no heuristic snapping.
A marker on a failed or unrecorded action degrades to a warning on the tool
result; it never fails the browser action itself.

`recording_marker` remains for checkpoints that belong to no single action —
chapter boundaries and preconditions. Its optional `placement` defaults to
`after_previous` for a confirmed result, while `before_next` denotes a
precondition before the next browser action.

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

Rec reads browser and replay defaults from its [configuration](configuration.md).
If a managed browser’s headless mode, viewport, or executable no longer matches,
`recording_browser_ensure` and `recording_status` report `restart_required`;
stop that managed browser and start a fresh task. The agent does not need a
configuration tool or prompt-level recording settings.

Rec's local daemon is started on demand. Rec MCP holds a short-lived agent
lease while its process is active; after it ends, Rec releases managed Chrome
after a small grace period. Opening a local replay keeps only the daemon
alive, not Chrome. This lifecycle is automatic; `rec daemon stop` is available
for an explicit shutdown after recording stops.

`recording_start` rejects an empty browser with guidance to navigate first;
`recording_stop` rejects an empty capture instead of returning a misleading replay
link. The recorder's existing password masking remains enabled; broader masking
policy is intentionally deferred to a later phase.

## Escape hatch: an external Playwright MCP

Set `REC_EMBEDDED_PLAYWRIGHT=0` to disable the embedded browser tools, then
configure a separate `playwright` MCP entry pointed at Rec's
[stdio-transparent launcher](../packages/playwright-launcher/README.md), which
starts a user-installed Playwright MCP against Rec's shared Chrome. This path
gives up atomic `rec_marker` checkpoints — only ordered `recording_marker`
calls associate markers with actions — and exists for users who must run a
specific Playwright MCP version Rec does not ship.

## Codex plugin

The local `rec-mcp` Codex plugin starts Rec MCP alone; the embedded Playwright
tools come with it. It is deliberately local-only: installation adds no hosted
service, credentials, or sharing capability.
