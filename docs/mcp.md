# Agent-native replay MCP server

`replay-mcp` is a local stdio MCP server. It gives an MCP-capable coding agent one
place to drive and capture a browser: the stock Playwright MCP browser tools
(embedded from a pinned `@playwright/mcp`) plus ten structured replay
tools. It never exposes the capture beyond the local machine; the `replay_*`
read tools below consume replays that were already explicitly shared.

| Tool | Purpose |
| --- | --- |
| `browser_*` (embedded) | The stock Playwright MCP tool surface, unchanged, driving Replay's shared Chrome. Every browser tool accepts an optional `replay_marker` checkpoint. |
| `capture_browser_ensure` | Launches or reuses Replay's configured dedicated Chrome and returns its CDP endpoint. |
| `capture_attach_browser` | Attaches Replay to an explicitly supplied loopback CDP endpoint; Replay never stops that external browser. |
| `capture_start` | Starts a replay on an attached browser, but only after a navigated in-scope page exists. |
| `capture_marker` | Adds a labelled checkpoint that belongs to no single browser action. |
| `capture_status` | Returns browser ownership, endpoint, page readiness, and active capture counts. |
| `capture_stop` | Stops capture and returns its ID, local bundle details, portable artifact path, and replay URL. With `REPLAY_SHARE_URL`, it also publishes automatically and returns `shareUrl`; `shareError` preserves the local handoff if upload fails. |
| `replay_share` | Explicitly uploads a stopped replay to `REPLAY_SHARE_URL` and returns its public bearer link plus `summaryUrl`, the agent-readable form of the same link. |
| `replay_overview` | Reads a remotely shared replay from its pasted share link: title, duration, pages, step timeline, markers, and agent actions with failures highlighted. Needs no configuration. |
| `replay_steps` | Zooms into a moment of a shared replay by `from_ms`/`to_ms` window or by marker label. |
| `replay_fetch` | Downloads a shared replay into the local Replay home so the local player and its assistant work on it like any local replay. |

## Single-server workflow

Replay embeds the stock Playwright MCP in-process, so the agent configures one
server and the browser it drives is always the browser Replay captures. The shared
Chrome is provisioned just-in-time on the first browser tool call; a user can
ask an agent to browse first and capture later without mentioning a browser,
port, or replay workflow.

1. Use the `browser_*` tools to navigate to the target application and inspect its initial state.
2. Call `capture_start` when a replay is requested.
3. Keep using the `browser_*` tools for every click, fill, wait, and tab action.
4. Pass `replay_marker` on a browser action to checkpoint it; use `capture_marker` only for action-less checkpoints.
5. Call `capture_stop` and use its `shareUrl` when configured, otherwise its local `replayUrl`.

Do not drive Web Preview, Arc, Codex's in-app browser, or an arbitrary normal
Chrome session while expecting Replay to capture it. Do not configure a second
Playwright MCP entry alongside Replay: the agent would see duplicate `browser_*`
tools, and actions sent to the duplicate are neither captured nor markable.

## Markers and actions

Every embedded browser tool accepts an optional `replay_marker` parameter:

```json
{ "name": "browser_click", "arguments": {
  "selector": "#submit",
  "replay_marker": { "label": "Submitted signup form", "note": "confirmed by toast" }
} }
```

Replay strips `replay_marker` before the call reaches Playwright and captures the
checkpoint atomically with the action: same request, same identity. The
replay's manifest logs every browser action with its request/response
bracket, and an action-bound marker anchors on its own action in the player —
there is no ordering between servers to get right and no heuristic snapping.
A marker on a failed or uncaptured action degrades to a warning on the tool
result; it never fails the browser action itself.

`capture_marker` remains for checkpoints that belong to no single action —
chapter boundaries and preconditions. Its optional `placement` defaults to
`after_previous` for a confirmed result, while `before_next` denotes a
precondition before the next browser action.

## Standalone setup

Build the repository, then configure any MCP client to launch the server over
stdio. Substitute this checkout's absolute path:

```json
{
  "mcpServers": {
    "replay": {
      "command": "node",
      "args": ["/absolute/path/to/replay/packages/mcp/dist/main.js"]
    }
  }
}
```

Set `REPLAY_DAEMON_URL` only when the daemon is intentionally running somewhere
other than `http://127.0.0.1:7717`. The MCP server starts the daemon on demand.

Replay reads browser and replay defaults from its [configuration](configuration.md).
If a managed browser’s headless mode, viewport, or executable no longer matches,
`capture_browser_ensure` and `capture_status` report `restart_required`;
stop that managed browser and start a fresh task. The agent does not need a
configuration tool or prompt-level replay settings.

Replay's local daemon is started on demand. Replay MCP holds a short-lived agent
lease while its process is active; after it ends, Replay releases managed Chrome
after a small grace period. Opening a local replay keeps only the daemon
alive, not Chrome. This lifecycle is automatic; `replay daemon stop` is available
for an explicit shutdown after capture stops.

`capture_start` rejects an empty browser with guidance to navigate first;
`capture_stop` rejects an empty capture instead of returning a misleading replay
link. The capture's existing password masking remains enabled; broader masking
policy is intentionally deferred to a later phase.

## Escape hatch: an external Playwright MCP

Set `REPLAY_EMBEDDED_PLAYWRIGHT=0` to disable the embedded browser tools, then
configure a separate `playwright` MCP entry pointed at Replay's
[stdio-transparent launcher](../packages/playwright-launcher/README.md), which
starts a user-installed Playwright MCP against Replay's shared Chrome. This path
gives up atomic `replay_marker` checkpoints — only ordered `capture_marker`
calls associate markers with actions — and exists for users who must run a
specific Playwright MCP version Replay does not ship.

## Codex plugin

The local `replay-mcp` Codex plugin starts Replay MCP alone; the embedded Playwright
tools come with it. It is deliberately local-only: installation adds no hosted
service, credentials, or sharing capability.
