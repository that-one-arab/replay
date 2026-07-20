# Phase 2: agent-native capture plan

## Objective

Enable a coding agent to drive a browser with stock Playwright MCP while Replay
independently captures that exact browser session and produces a local replay
artifact. Replay must never silently produce an empty replay when the agent drove a
different browser.

Phase 2 is local-first. Hosted uploads, sharing, authentication, collaboration,
and expanded masking policy remain later work.

## Design decisions

| Area | Decision |
| --- | --- |
| Browser control | Stock Playwright MCP owns browser interaction. Replay does not proxy or reimplement Playwright actions. |
| Playwright startup | Replay's stdio-transparent launcher ensures the shared browser, then starts the separately installed stock Playwright MCP. |
| Replay | Replay MCP owns browser setup, attachment, replay lifecycle, markers, diagnostics, and replay handoff. |
| Shared state | Both systems attach to one Chromium CDP endpoint. |
| Default browser | Replay launches and owns a dedicated Chrome instance on `http://127.0.0.1:9333`. |
| External browser | Replay attaches only when given an explicit CDP endpoint; it never guesses an arbitrary running Chrome. |
| Markers | Optional semantic checkpoints. They are ordered relative to actions, not technically correlated through action IDs. |
| Marker placement | `after_previous` is the default; `before_next` is available for a precondition or chapter boundary. |
| Empty replays | Stop must fail clearly when no capture data exists; it must not present a misleading replay link. |
| Input handling | Preserve current password masking. Do not add broader masking controls in this phase. |
| CI | Do not add CI. Verify locally. |

## Architecture

```text
Coding agent
  ├─ Playwright MCP: navigate, inspect, click, fill, wait, manage tabs
  └─ Replay MCP: start, mark, status, stop
                         │
                         ▼
       Replay Playwright launcher ensures one Chromium CDP endpoint
                         │
              ┌──────────┴──────────┐
              │                     │
     Playwright MCP client   Replay capture client
```

Playwright remains a separate dependency and retains its full tool surface. Replay
uses `playwright-core` internally to attach and inject rrweb, but it does not
become the agent's browser-driving interface.

## Expected agent workflow

```text
1. Playwright: navigate to the target application
2. Playwright: inspect or snapshot the initial state
3. Replay: capture_start when the user asks for a replay
4. Playwright: perform one meaningful action
5. Playwright: wait for or inspect the expected UI result
6. Replay: optionally add a marker describing the confirmed state
7. Repeat steps 4–6 as needed
8. Replay: capture_stop
9. Return the replay URL and outcome
```

Example:

```text
Playwright: navigate http://localhost:3000
Replay: capture_start "Checkout failure"
Replay: capture_marker "Submitting checkout" placement=before_next
Playwright: click Submit
Playwright: wait for "Card number is required"
Replay: capture_marker "Validation error shown" placement=after_previous
Replay: capture_stop outcome=reproduced
```

The reviewer sees a useful narrative. The system does not claim that a marker is
a durable Playwright action ID; it captures the ordered meaning the agent supplied.

## Replay MCP contract

### `capture_browser_ensure`

Ensures Replay's managed Chrome exists and is reachable. The Playwright launcher
uses this internally; it remains available for CLI, standalone MCP, and advanced
callers.

Input:

```json
{
  "browserExecutable": "/optional/path/to/Chrome"
}
```

Result:

```json
{
  "managed": true,
  "launched": true,
  "cdpEndpoint": "http://127.0.0.1:9333",
  "browserState": "ready"
}
```

Behavior:

- Reuse a healthy Replay-managed browser.
- Recover stale `browser.json` state and launch a fresh browser when needed.
- Attach the capture daemon to the browser.
- Do not navigate, open a page, or begin a replay.
- Never attempt to discover or take over arbitrary normal Chrome instances.

### `capture_attach_browser`

Attaches Replay to an explicitly supplied browser endpoint for advanced callers.

Input:

```json
{
  "cdpEndpoint": "http://127.0.0.1:9222"
}
```

Initial rules:

- Support loopback endpoints only.
- Reject attachment changes while a capture is active.
- Mark the browser as externally managed, so Replay never terminates it.

### `capture_start`

Starts rrweb capture on an attached browser.

Inputs remain title, origin allowlist, and optional canvas capture. The response
also includes the active CDP endpoint and capture state.

Default precondition:

- At least one navigated, in-scope top-level page must exist.

If no usable page exists, fail with actionable guidance:

```text
No navigated page is available to capture.
Use Playwright MCP to open the target page, then call capture_start.
```

This prevents a title and origin allowlist from creating a valid-looking bundle
with zero captured segments.

### `capture_marker`

Markers are optional and describe meaningful checkpoints. Extend the marker format
without breaking existing replays:

```json
{
  "label": "Validation error shown",
  "note": "The card-number error is visible after submit.",
  "placement": "after_previous"
}
```

Allowed placement values:

| Value | Meaning |
| --- | --- |
| `after_previous` | A confirmed result immediately after the preceding Playwright action and any relevant wait. This is the default. |
| `before_next` | A precondition, chapter boundary, or important state immediately before the next Playwright action. |

The player can initially render these markers as it does today. The placement is
durable metadata for agent guidance and later timeline/review improvements.

### `capture_status`

Expose enough state for an agent to diagnose an incorrect browser target:

```json
{
  "state": "page_ready",
  "cdpEndpoint": "http://127.0.0.1:9333",
  "managedBrowser": true,
  "pageCount": 1,
  "navigatedPageCount": 1,
  "replay": null
}
```

While capturing, add session ID, elapsed time, segment count, and event count.

### `capture_stop`

Before returning a replay URL, validate that the capture has at least one segment
and persisted event data. Do not use `activeDurationMs` alone: a valid short
replay can report zero active duration.

If the capture is empty, return an MCP error rather than a replay handoff.

## Playwright MCP configuration

Users install Playwright MCP separately. In Codex and other supported clients,
the documented configuration starts Replay's launcher rather than Playwright MCP
directly:

```toml
[mcp_servers.playwright]
command = "node"
args = ["/absolute/path/to/replay/packages/playwright-launcher/dist/main.js"]

[mcp_servers.replay]
command = "node"
args = ["/absolute/path/to/replay/packages/mcp/dist/main.js"]
```

The launcher ensures Replay Chrome before starting stock Playwright MCP. It then
forwards stdin and stdout unchanged, and does not proxy tools or become a
Playwright dependency. The launcher may be used by any MCP-capable coding client.

## Agent guidance

The Replay Codex plugin should include a small replay workflow instruction:

- Use Playwright MCP for every browser interaction.
- Use Replay MCP only for replay lifecycle, status, markers, and replay handoff.
- Do not use Web Preview, Arc, Codex's in-app browser, or an arbitrary manually
  opened Chrome for a replay unless its CDP endpoint was explicitly
  attached.
- Do not ask users to start capturing or provide a CDP endpoint; the launcher owns that
  rendezvous. Confirm the expected browser/page state with `capture_status`
  before starting.
- Never issue Playwright actions and Replay markers in parallel.
- Add markers after visible outcomes, or immediately before an important next
  action when using `before_next`.
- Treat an empty capture as a failed artifact and retry in the shared browser.

## Diagnostics and lifecycle rules

| Situation | Required behavior |
| --- | --- |
| No managed browser | Guide the agent to `capture_browser_ensure`. |
| Playwright uses another browser | Explain that Playwright must use Replay's returned CDP endpoint. |
| No navigated page | Reject replay start with the navigate-first guidance. |
| Stale browser state | Recover and report that a new browser was launched. |
| External CDP endpoint fails | Return the endpoint-specific connection error. |
| Stop has no events | Return an error and do not offer a replay URL. |

Replay stops only browsers it launched. An explicitly attached external browser is
never terminated by Replay. Reattachment while capturing is rejected.

## Implementation work packages

### 1. Browser lifecycle and daemon API

- Add daemon support for browser ensure and explicit attach lifecycle.
- Make stale browser-state recovery reliable.
- Expose browser ownership, endpoint, page readiness, and capture capture counts
  through health/status responses.
- Reject attach changes while capturing.

### 2. Capture readiness and empty-capture protection

- Detect whether the attached browser has an in-scope navigated page before start.
- Return a clear start error when no page is ready.
- Add a capture summary with segments/chunks/event count.
- Reject empty stop results before a replay URL is returned.

### 3. MCP server contract

- Add `capture_browser_ensure` and `capture_attach_browser`.
- Enrich start/status/stop responses with endpoint and readiness diagnostics.
- Add optional marker `placement`, defaulting old and new unspecified markers to
  `after_previous`.
- Keep the existing lifecycle tools backward compatible.

### 4. Plugin and documentation

- Keep the Replay plugin independent from the Playwright package.
- Add the replay workflow guidance to the plugin.
- Document the two-MCP-server configuration and required call order.
- Clearly distinguish a replay URL from a CDP endpoint.

### 5. Local validation

- Add local unit/regression coverage for ensure, stale recovery, external attach,
  start-without-page, attachment-while-replay rejection, marker placement, and
  empty-stop rejection.
- Use local regression coverage and a fresh-agent acceptance check to validate the
  separate Replay and stock Playwright MCP workflow.
- Do not add CI.

## Acceptance criteria

Phase 2 is complete when a fresh coding-agent task can:

1. Ensure a Replay-managed browser.
2. Drive that exact browser with a separately installed stock Playwright MCP.
3. Start capturing only after a usable page exists.
4. Perform and verify a browser workflow with Playwright.
5. Optionally add ordered `before_next` and `after_previous` markers.
6. Stop and receive a nonempty replay URL.
7. Open the replay and see the driven interaction.
8. Receive a clear error instead of a false-success replay whenever automation and
   replay are connected to different browser targets.

## Explicitly deferred

- Playwright action IDs and cross-server causal marker association
- A Replay proxy around Playwright MCP
- Batching/composed browser-and-marker calls
- Hosted sharing, authentication, access control, comments, and collaboration
- New input-masking policy
- CI integration
- Implicit discovery of arbitrary existing browser sessions
