# Phase 2 acceptance: fresh coding-agent replay

This is the human acceptance check for the agent-native capture workflow. It
confirms that a fresh coding-agent task can use the normal two-MCP workflow
without a developer explaining browser ports or Replay commands.

## Prerequisites

1. Build Replay: `npm run build`.
2. Install the local Replay Codex plugin (or configure the two MCP servers described
   in [MCP setup](mcp.md)). Playwright MCP remains a separately installed
   dependency.
3. Start the target local app. For a disposable deterministic target, use the
   Todo demo and its `BUG_TICKET.md` outside this repository.

## Reproduction handoff

Start a new Codex task in the target app. Give it only the normal developer
request, for example:

> Read BUG_TICKET.md, reproduce the issue, and capture a replay with Replay.

Accept the flow when all of the following are true:

- The agent navigates and inspects with Playwright, then starts Replay only after a
  usable page exists. It does not ask for a Chrome port or use an unrelated
  browser surface.
- Replay returns one non-empty replay URL and the agent supplies it with a concise
  outcome.
- The replay shows the actual click/fill/navigation sequence, readable cursor
  transitions, any reload context, and the reproduced visible state.
- Markers, when used, tell the story in the order the action and confirmed
  outcome occurred. They are optional; an action without a marker is valid.
- `capture_status` reports the shared browser/page state before capture; a
  stale target, no page, or empty capture produces a useful error rather than a
  zero-second replay.

## Fix handoff

In the same task after the change is implemented, ask:

> Verify the fix in the browser and capture a replay of the verified result.

Accept the flow when it creates a second, separate replay. Its replay must
show the verification path and final visible result; it must not overwrite or
silently reuse the reproduction capture.
