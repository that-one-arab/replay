---
name: rec-browser-recording
description: Record and hand off a local browser-session replay with Rec. Use when the user asks to record, capture, replay, or share browser evidence of a bug reproduction, verification, or fix.
---

# Rec browser recording

The Rec MCP server provides everything: the stock Playwright browser tools
(`browser_navigate`, `browser_click`, ...) for driving the page, and the
`recording_*` tools for the recording lifecycle and handoff. There is no
separate Playwright server to configure or coordinate with.

1. Navigate and inspect the target page with the `browser_*` tools. Rec's
   shared Chrome starts automatically on the first browser action.
2. For a requested capture, call `recording_status`. Start only when its state
   is `page_ready`.
3. Call `recording_start`, then drive and verify the requested browser flow.
   Direct a recording that is conclusive and unambiguous: a viewer who watches
   it once should see exactly what happened and why, with no guesswork. Start
   from a clear, recognizable state, perform each step deliberately, and let
   the decisive moment land on screen long enough to read. Hover meaningful
   targets before clicking, and use normal typing or key presses for short
   visible values when available. Do not leave the outcome implied — make it
   visible.
4. To label a milestone, pass `rec_marker` on the browser action itself, for
   example `browser_click` with
   `rec_marker: { label: "Submitted signup form" }`. The checkpoint is
   recorded atomically with that action, so there is no ordering to get right.
   Use `recording_marker` only for checkpoints that belong to no single
   action, such as a chapter boundary or a precondition note. Markers are
   optional; mark visible milestones, not every step.
5. After confirming the requested outcome, call `recording_stop`. It saves the
   recording locally and returns a local replay URL for immediate preview; it
   does not upload. Return that replay URL.
6. Do not upload. Stopping keeps the recording local, and that is where it
   stays by default — never call `recording_share` on your own initiative, even
   after a successful reproduction or fix. Upload only when the user explicitly
   asks you to share, upload, or send a link. When they do, call
   `recording_share` with the stopped `sessionId` to upload it and return the
   resulting share URL, or point them at the Share button inside the player.
   Sharing requires `REC_SHARE_URL` to be configured. If you are unsure whether
   the user wants a shared link, hand back the local replay URL and let them
   decide.

Record the final verified flow by default. Capture a broken reproduction only
when the user explicitly requests evidence of the failure. When reproducing a
bug, the recording must be self-contained: include every step the user needs to
follow to trigger it, in order, from a known starting point through the failure
itself — no skipped setup, no assumed prior state. Someone who follows the
recorded steps should hit the same bug every time. Use `rec_marker` on the key
actions and on the action where the bug appears so the sequence is easy to
follow.

If start reports no page, navigate with the `browser_*` tools and retry. If a
recording is empty, redo it as a fresh session and confirm the browser tools
being used are Rec's own (not another Playwright server's).
