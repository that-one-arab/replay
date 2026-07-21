---
name: replay-browser-capture
description: Capture and hand off a local browser-session replay with Replay. Use when the user asks to capture, replay, or share browser evidence of a bug reproduction, verification, or fix.
---

# Replay browser capture

The Replay MCP server provides everything: the stock Playwright browser tools
(`browser_navigate`, `browser_click`, ...) for driving the page, and the
`capture_*` / `replay_*` tools for the replay lifecycle and handoff. There is no
separate Playwright server to configure or coordinate with.

## One issue per recording

A replay exists to make a single issue immediately understandable to someone who
hasn't read the ticket. Cramming several issues into one replay makes none of
them land. If a request names several issues, capture one replay per issue and
return each replay link labeled with the issue it demonstrates.

## Two phases: discover, then perform

You cannot plan a reproduction you don't yet understand — you discover it by
exploring, and that exploration is messy. Keep the mess out of the artifact by
working in two phases, in the **same browser** (so the state that triggers the
bug survives between phases):

1. **Discovery — scratch, never recorded.** Drive freely with the `browser_*`
   tools and **do not** call `capture_start`. Fumble until you have reproduced
   the bug and can name: the exact path, the offending element, what it should
   be (expected), and what it actually is (actual). Nothing in this phase is
   shipped.
2. **Performance — the artifact.** Navigate back to a clean starting point in
   the same browser, then call `capture_start`, and re-drive the now-known steps
   deliberately. This pass contains only intentional steps — that is what the
   viewer sees. Direct it to be conclusive and unambiguous: a viewer who watches
   it once should see exactly what happened and why, with no guesswork. Start
   from a clear, recognizable state, perform each step deliberately, and let the
   decisive moment land on screen long enough to read.

Never validate and record at the same time. If the performance pass itself
fumbles (a wrong click on a now-known path), stop, re-navigate to the start, and
redo the whole performance pass — do not try to patch or narrate over the
mistake.

The performance pass must start on the feature, not on the login or setup flow
that got you there — capture the bug, not the sign-in. `capture_start` warns
when it sees an auth/setup page; treat that warning as "navigate to the feature
first." Login belongs to discovery; the artifact opens on the reproduction.

## Point at the defect with capture_highlight

At the decisive moment, call `capture_highlight` to pin the viewer's attention to
the offending element. Pass the element's visible text (which you can read from
`browser_snapshot`) and the expected-vs-actual claim, for example:

    capture_highlight({
      element: { text: "1 of 3 completed" },
      defect: { expected: "Step 2 of 3", actual: "1 of 3 completed" },
      hold: "until_ack"
    })

The element is resolved to a DOM node at capture time, so the player rings (and,
if the viewer has the camera on, zooms into) the exact thing that is wrong, with
expected vs. actual shown beside it. Use a `note` instead of a `defect` for a
freeform callout. `hold` controls whether playback pauses there: `until_ack`
waits for the viewer to continue, `beat` pauses briefly, `none` does not pause.

For ordinary milestones that aren't defects, keep using `replay_marker` on the
browser action itself (e.g. `browser_click` with `replay_marker: { label:
"Submitted signup form" }`) — the checkpoint is captured atomically with that
action. Use `capture_marker` only for checkpoints tied to no single action, such
as a chapter boundary or precondition. Markers and highlights are both optional;
mark visible milestones and the defect, not every step.

Attach `replay_marker` only to an action that succeeds — a failed action is not a
milestone, and marking both a failed attempt and its retry creates duplicate
chapters. If an action fails, re-snapshot, retry it, and mark the successful
retry. Do not re-perform and re-mark setup steps you have already completed.

A defect highlight must *resolve* — `capture_highlight` warns if the element was
not found on the page, in which case the viewer sees no ring. Re-snapshot and
retry it with the element's current visible text until it resolves. For a bug
reproduction, a resolved defect highlight is mandatory: `capture_stop` with
`outcome=reproduced` requires one (and in strict mode refuses to stop without
it). Put the highlight at the observable defect — the wrong toast, the silent
button, the missing value — not at your own keystroke that set it up.

## Start, stop, and share

1. Navigate and inspect the target page with the `browser_*` tools. Replay's
   shared Chrome starts automatically on the first browser action.
2. During discovery, drive with `browser_*` without `capture_start`. When the
   repro is understood, navigate to the start and call `capture_status` —
   `capture_start` is valid once its state is `page_ready`.
3. Call `capture_start`, then re-drive the known flow on the performance pass.
4. At the defect, call `capture_highlight` with the element and the defect.
5. After confirming the outcome, call `capture_stop`. It saves the replay
   locally and returns a local replay URL for immediate preview; it does not
   upload. Return that URL.
6. Do not upload. Stopping keeps the replay local, and that is where it stays by
   default — never call `replay_share` on your own initiative, even after a
   successful reproduction or fix. Upload only when the user explicitly asks you
   to share, upload, or send a link. When they do, call `replay_share` with the
   stopped `sessionId` to upload it and return the resulting share URL, or point
   them at the Share button inside the player. Sharing requires
   `REPLAY_SHARE_URL` to be configured. If you are unsure whether the user wants
   a shared link, hand back the local replay URL and let them decide.

Capture the final verified flow by default. Capture a broken reproduction only
when the user explicitly requests evidence of the failure. When reproducing a
bug, the performance pass must be self-contained: include every step the user
needs to follow to trigger it, in order, from a known starting point through the
failure itself — no skipped setup, no assumed prior state. Someone who follows
the captured steps should hit the same bug every time.

## Review your own replay before handing it over

You are the last check on the artifact you just recorded. Right after
`capture_stop`, call `replay_review` (it defaults to the session you just
stopped). It returns the replay's distilled timeline plus deterministic findings.
Read both and judge whether the replay is fit to hand over.

Clear every finding before sharing. The three findings are the failures that
make a replay useless to a viewer:

- `opens_on_auth_page` — the replay opens on a login/setup screen. Discovery was
  captured, not performed. Re-record starting from the feature page.
- `no_resolved_defect_highlight` — no defect highlight resolved to an element,
  so the viewer never sees what is wrong. Drop a `capture_highlight` at the
  observable defect (with `defect: { expected, actual }`) until it resolves,
  then re-record so the highlight lands in a clean pass.
- `discovery_noise_after_last_marker` — after your final marker the capture
  still shows inspection (`browser_find`, screenshots, network reads), meaning
  you were still hunting for the bug inside the recording. Re-record a
  performance pass that contains only deliberate steps.

`capture_stop` already returns these same findings as warnings; `replay_review`
gives you the full timeline to confirm. If any finding is present, **do not hand
the link to the user** — re-record a clean performance pass rather than narrate
over the problem. The review is your own judgment; treat the findings as
mandatory to clear for a bug reproduction.

If `capture_start` reports no page, navigate with the `browser_*` tools and
retry. If a replay is empty, redo it as a fresh session and confirm the browser
tools being used are Replay's own (not another Playwright server's).
