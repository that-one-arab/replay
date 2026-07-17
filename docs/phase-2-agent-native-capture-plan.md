# Phase 2: agent-native capture plan

## Objective

Enable a coding agent to drive a browser with stock Playwright MCP while Rec
independently records that exact browser session and produces a local replay
artifact. Rec must never silently produce an empty replay when the agent drove a
different browser.

Phase 2 is local-first. Hosted uploads, sharing, authentication, collaboration,
and expanded masking policy remain later work.

## Design decisions

| Area | Decision |
| --- | --- |
| Browser control | Stock Playwright MCP owns browser interaction. Rec does not proxy or reimplement Playwright actions. |
| Playwright startup | Rec's stdio-transparent launcher ensures the shared browser, then starts the separately installed stock Playwright MCP. |
| Recording | Rec MCP owns browser setup, attachment, recording lifecycle, markers, diagnostics, and replay handoff. |
| Shared state | Both systems attach to one Chromium CDP endpoint. |
| Default browser | Rec launches and owns a dedicated Chrome instance on `http://127.0.0.1:9333`. |
| External browser | Rec attaches only when given an explicit CDP endpoint; it never guesses an arbitrary running Chrome. |
| Markers | Optional semantic checkpoints. They are ordered relative to actions, not technically correlated through action IDs. |
| Marker placement | `after_previous` is the default; `before_next` is available for a precondition or chapter boundary. |
| Empty recordings | Stop must fail clearly when no capture data exists; it must not present a misleading replay link. |
| Input handling | Preserve current password masking. Do not add broader masking controls in this phase. |
| CI | Do not add CI. Verify locally. |

## Architecture

```text
Coding agent
  ├─ Playwright MCP: navigate, inspect, click, fill, wait, manage tabs
  └─ Rec MCP: start, mark, status, stop
                         │
                         ▼
       Rec Playwright launcher ensures one Chromium CDP endpoint
                         │
              ┌──────────┴──────────┐
              │                     │
     Playwright MCP client   Rec recorder client
```

Playwright remains a separate dependency and retains its full tool surface. Rec
uses `playwright-core` internally to attach and inject rrweb, but it does not
become the agent's browser-driving interface.

## Expected agent workflow

```text
1. Playwright: navigate to the target application
2. Playwright: inspect or snapshot the initial state
3. Rec: recording_start when the user asks for a recording
4. Playwright: perform one meaningful action
5. Playwright: wait for or inspect the expected UI result
6. Rec: optionally add a marker describing the confirmed state
7. Repeat steps 4–6 as needed
8. Rec: recording_stop
9. Return the replay URL and outcome
```

Example:

```text
Playwright: navigate http://localhost:3000
Rec: recording_start "Checkout failure"
Rec: recording_marker "Submitting checkout" placement=before_next
Playwright: click Submit
Playwright: wait for "Card number is required"
Rec: recording_marker "Validation error shown" placement=after_previous
Rec: recording_stop outcome=reproduced
```

The reviewer sees a useful narrative. The system does not claim that a marker is
a durable Playwright action ID; it records the ordered meaning the agent supplied.

## Rec MCP contract

### `recording_browser_ensure`

Ensures Rec's managed Chrome exists and is reachable. The Playwright launcher
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

- Reuse a healthy Rec-managed browser.
- Recover stale `browser.json` state and launch a fresh browser when needed.
- Attach the recorder daemon to the browser.
- Do not navigate, open a page, or begin a recording.
- Never attempt to discover or take over arbitrary normal Chrome instances.

### `recording_attach_browser`

Attaches Rec to an explicitly supplied browser endpoint for advanced callers.

Input:

```json
{
  "cdpEndpoint": "http://127.0.0.1:9222"
}
```

Initial rules:

- Support loopback endpoints only.
- Reject attachment changes while a recording is active.
- Mark the browser as externally managed, so Rec never terminates it.

### `recording_start`

Starts rrweb capture on an attached browser.

Inputs remain title, origin allowlist, and optional canvas capture. The response
also includes the active CDP endpoint and recorder state.

Default precondition:

- At least one navigated, in-scope top-level page must exist.

If no usable page exists, fail with actionable guidance:

```text
No navigated page is available to record.
Use Playwright MCP to open the target page, then call recording_start.
```

This prevents a title and origin allowlist from creating a valid-looking bundle
with zero captured segments.

### `recording_marker`

Markers are optional and describe meaningful checkpoints. Extend the marker format
without breaking existing recordings:

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

### `recording_status`

Expose enough state for an agent to diagnose an incorrect browser target:

```json
{
  "state": "page_ready",
  "cdpEndpoint": "http://127.0.0.1:9333",
  "managedBrowser": true,
  "pageCount": 1,
  "navigatedPageCount": 1,
  "recording": null
}
```

While recording, add session ID, elapsed time, segment count, and event count.

### `recording_stop`

Before returning a replay URL, validate that the capture has at least one segment
and persisted event data. Do not use `activeDurationMs` alone: a valid short
recording can report zero active duration.

If the capture is empty, return an MCP error rather than a replay handoff.

## Playwright MCP configuration

Users install Playwright MCP separately. In Codex and other supported clients,
the documented configuration starts Rec's launcher rather than Playwright MCP
directly:

```toml
[mcp_servers.playwright]
command = "node"
args = ["/absolute/path/to/rec/packages/playwright-launcher/dist/main.js"]

[mcp_servers.rec]
command = "node"
args = ["/absolute/path/to/rec/packages/mcp/dist/main.js"]
```

The launcher ensures Rec Chrome before starting stock Playwright MCP. It then
forwards stdin and stdout unchanged, and does not proxy tools or become a
Playwright dependency. The launcher may be used by any MCP-capable coding client.

## Agent guidance

The Rec Codex plugin should include a small recording workflow instruction:

- Use Playwright MCP for every browser interaction.
- Use Rec MCP only for recording lifecycle, status, markers, and replay handoff.
- Do not use Web Preview, Arc, Codex's in-app browser, or an arbitrary manually
  opened Chrome for a Rec recording unless its CDP endpoint was explicitly
  attached.
- Do not ask users to start Rec or provide a CDP endpoint; the launcher owns that
  rendezvous. Confirm the expected browser/page state with `recording_status`
  before starting.
- Never issue Playwright actions and Rec markers in parallel.
- Add markers after visible outcomes, or immediately before an important next
  action when using `before_next`.
- Treat an empty capture as a failed artifact and retry in the shared browser.

## Diagnostics and lifecycle rules

| Situation | Required behavior |
| --- | --- |
| No managed browser | Guide the agent to `recording_browser_ensure`. |
| Playwright uses another browser | Explain that Playwright must use Rec's returned CDP endpoint. |
| No navigated page | Reject recording start with the navigate-first guidance. |
| Stale browser state | Recover and report that a new browser was launched. |
| External CDP endpoint fails | Return the endpoint-specific connection error. |
| Stop has no events | Return an error and do not offer a replay URL. |

Rec stops only browsers it launched. An explicitly attached external browser is
never terminated by Rec. Reattachment while recording is rejected.

## Implementation work packages

### 1. Browser lifecycle and daemon API

- Add daemon support for browser ensure and explicit attach lifecycle.
- Make stale browser-state recovery reliable.
- Expose browser ownership, endpoint, page readiness, and recorder capture counts
  through health/status responses.
- Reject attach changes while recording.

### 2. Recorder readiness and empty-capture protection

- Detect whether the attached browser has an in-scope navigated page before start.
- Return a clear start error when no page is ready.
- Add a capture summary with segments/chunks/event count.
- Reject empty stop results before a replay URL is returned.

### 3. MCP server contract

- Add `recording_browser_ensure` and `recording_attach_browser`.
- Enrich start/status/stop responses with endpoint and readiness diagnostics.
- Add optional marker `placement`, defaulting old and new unspecified markers to
  `after_previous`.
- Keep the existing lifecycle tools backward compatible.

### 4. Plugin and documentation

- Keep the Rec plugin independent from the Playwright package.
- Add the recording workflow guidance to the plugin.
- Document the two-MCP-server configuration and required call order.
- Clearly distinguish a replay URL from a CDP endpoint.

### 5. Local validation

- Add local unit/regression coverage for ensure, stale recovery, external attach,
  start-without-page, attachment-while-recording rejection, marker placement, and
  empty-stop rejection.
- Add an opt-in local smoke command that launches Rec Chrome, starts stock
  Playwright MCP against it, drives the deterministic demo, records a marker, and
  validates a nonempty replay.
- Do not add CI.

## Acceptance criteria

Phase 2 is complete when a fresh coding-agent task can:

1. Ensure a Rec-managed browser.
2. Drive that exact browser with a separately installed stock Playwright MCP.
3. Start recording only after a usable page exists.
4. Perform and verify a browser workflow with Playwright.
5. Optionally add ordered `before_next` and `after_previous` markers.
6. Stop and receive a nonempty replay URL.
7. Open the replay and see the driven interaction.
8. Receive a clear error instead of a false-success replay whenever automation and
   recording are connected to different browser targets.

## Explicitly deferred

- Playwright action IDs and cross-server causal marker association
- A Rec proxy around Playwright MCP
- Batching/composed browser-and-marker calls
- Hosted sharing, authentication, access control, comments, and collaboration
- New input-masking policy
- CI integration
- Implicit discovery of arbitrary existing browser sessions
