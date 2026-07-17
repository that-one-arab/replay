# Product roadmap

## Goal

Enable coding agents to capture a browser session and hand a safe, useful replay to
another person without asking that person to reproduce the issue or workflow.

## Phase 1 — local recording fidelity (complete)

The local recorder and replay prove the core artifact: rrweb capture over CDP,
idle-aware playback, assets, markers, and one browser-session timeline across tabs.
Recordings remain on the originating machine.

## Phase 2 — agent-native capture workflow

Make recording a first-class action for coding agents rather than a sequence of
shell instructions. Deliver a small, structured tool surface for starting and
stopping captures, adding markers, reading recording status, and returning the
replay artifact and outcome to the agent's parent task. The tool contract should
make origin scope, input masking, and failure states explicit.

## Phase 3 — portable recording artifacts

Allow a completed session to be exported, imported, and replayed independently of
the recording machine. Define a versioned bundle, integrity checks, and a static
or local viewer so an agent can attach the artifact to a handoff before hosted
sharing exists.

## Phase 4 — secure sharing and review

Add the service needed for collaborators to open a recording through a durable
share link: upload, access control, expiration/revocation, and a hosted replay
viewer. Include review affordances that make the artifact useful in a coding
workflow, such as markers, notes, and a concise recorded outcome.

## Phase 5 — production hardening (intentionally late)

The previously proposed real-world recorder-hardening work belongs here, after the
agent workflow and sharing path have established the product contract. Broaden
coverage for rapid navigation and SPA routes, redirects, frames, uploads, canvas,
long recordings, storage recovery, recording-health diagnostics, performance, and
accessibility. This phase turns the proven workflow into a dependable product; it
is not the next milestone.

