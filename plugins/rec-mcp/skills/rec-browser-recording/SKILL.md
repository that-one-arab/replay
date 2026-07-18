---
name: rec-browser-recording
description: Record and hand off a local browser-session replay with Rec. Use when the user asks to record, capture, replay, or share browser evidence of a bug reproduction, verification, or fix while Playwright MCP is available.
---

# Rec browser recording

Use Playwright MCP for every browser interaction. Use Rec MCP only for the
recording lifecycle, useful checkpoints, and handoff.

1. Navigate and inspect the target page with Playwright. The bundled launcher
   already starts Rec's shared Chrome when needed.
2. For a requested capture, call `recording_status`. Start only when its state
   is `page_ready`.
3. Call `recording_start`, then drive and verify the requested browser flow
   with Playwright. Hover meaningful targets before clicking, and use normal
   typing or key presses for short visible values when available.
4. Add `recording_marker` only for visible milestones. Markers are optional;
   never send a marker and a Playwright action in parallel.
5. After confirming the requested outcome, call `recording_stop`. Return its
   `shareUrl` when present; otherwise return the local replay URL.

Record the final verified flow by default. Capture a broken reproduction only
when the user explicitly requests evidence of the failure.

If start reports no page, navigate with Playwright and retry. If a recording is
empty, check that Playwright is connected through Rec's launcher, then redo it
as a fresh session.
