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
   with Playwright. Direct a recording that is conclusive and unambiguous: a
   viewer who watches it once should see exactly what happened and why, with no
   guesswork. Start from a clear, recognizable state, perform each step
   deliberately, and let the decisive moment land on screen long enough to
   read. Hover meaningful targets before clicking, and use normal typing or key
   presses for short visible values when available. Do not leave the outcome
   implied — make it visible.
4. Add `recording_marker` only for visible milestones. Markers are optional;
   never send a marker and a Playwright action in parallel.
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
recorded steps should hit the same bug every time. Use `recording_marker` to
label the key steps and the moment the bug appears so the sequence is easy to
follow.

If start reports no page, navigate with Playwright and retry. If a recording is
empty, check that Playwright is connected through Rec's launcher, then redo it
as a fresh session.
