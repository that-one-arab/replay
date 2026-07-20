# Product roadmap

## Goal

Enable coding agents to capture a browser session and hand a safe, useful replay to
another person without asking that person to reproduce the issue or workflow.

## Phase 1 — local replay fidelity (complete)

The local capture and replay prove the core artifact: rrweb capture over CDP,
idle-aware playback, assets, markers, and one browser-session timeline across tabs.
Replays remain on the originating machine.

## Phase 2 — agent-native capture workflow (complete)

Replay is a first-class coding-agent workflow: stock Playwright MCP drives the
browser while Replay MCP captures that exact browser and returns a local replay. The
local handoff contract, browser ownership rules, ordered optional markers, empty
capture protection, regression coverage, and fresh-agent acceptance checklist are
complete. Broader masking policy and production hardening remain intentionally
deferred.

## Phase 3 — portable replay artifacts (complete)

Allow a completed session to be exported, imported, and replayed independently of
the replay machine. Define a versioned bundle, integrity checks, and a static
or local viewer so an agent can attach the artifact to a handoff before hosted
sharing exists. Implementation and maintenance notes are in
[phase-3-portable-artifacts.md](phase-3-portable-artifacts.md).

## Phase 4 — secure sharing and review (in progress)

Add the service needed for collaborators to open a replay through a durable
share link: upload, access control, expiration/revocation, and a hosted replay
viewer. Include review affordances that make the artifact useful in a coding
workflow, such as markers, notes, and a concise captured outcome.

The current Phase 4A Railway implementation is intentionally limited to public
bearer links; deployment and known deferrals are documented in
[phase-4-railway-sharing.md](phase-4-railway-sharing.md).

## Phase 5 — production hardening (intentionally late)

The previously proposed real-world capture-hardening work belongs here, after the
agent workflow and sharing path have established the product contract. Broaden
coverage for rapid navigation and SPA routes, redirects, frames, uploads, canvas,
long replays, storage recovery, replay-health diagnostics, performance, and
accessibility. This phase turns the proven workflow into a dependable product; it
is not the next milestone.
