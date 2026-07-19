# Phase 4B — remote replay query for coding agents

## Scope

A share link today is only useful to a human with a browser. This slice makes a
remotely shared replay queryable by coding agents: an agent that receives
`https://<share-host>/r/<id>` in a ticket, PR, or chat message can read what
happened in the recording without the originating machine, a local session, or
a human narrating the replay.

The slice deliberately does **not** add:

- server-side screen reconstruction (pixels or visible text at a timestamp) —
  see "Deferred: the screen endpoint" below,
- network or console capture (the recording format does not contain them),
- authentication or per-share authorization beyond the existing bearer-link
  model,
- any hosted LLM "ask this recording" endpoint. The querying agent already is
  an LLM; the service provides clean structured reads and nothing more.

## Use cases

1. **Bug handoff.** A teammate or QA agent records a repro and pastes the share
   link into a ticket. The coding agent picking up the ticket reads the step
   timeline, typed inputs, markers, and failures directly from the link.
2. **PR verification review.** Markers are bound to browser actions, so a
   replay serves as evidence that a fix was exercised. A reviewer agent checks
   that the recorded flow actually hit the changed path.
3. **Cross-machine agent collaboration.** Agent A reproduces a bug in CI,
   uploads, and hands the link to agent B fixing locally. The replay is the
   only shared artifact between the two contexts.
4. **Test generation.** The manifest's `actions` array is a structured trace of
   every browser tool call with args and timing; an agent can derive a
   Playwright regression test from a shared repro.
5. **Triage and dedup.** An agent sweeping bug reports pulls summaries of
   several replays and clusters duplicates by URL and step similarity.

## What is queryable

A replay contains the rrweb DOM event stream, navigation and tab events, agent
actions (tool, args summary, timing, ok/fail), markers, and assets. Derived
from those: the humanized step timeline (`summarizeReplay` in
`packages/core/src/summary.ts`) and step slices (`stepsInRange`). A replay does
**not** contain network requests or console logs; the query surface must not
imply otherwise.

## Architecture

Three layers, all served by `packages/share-server`, which already imports
every upload into a real `SessionStore` and therefore has the manifest, event
chunks, and assets on disk. Every layer below is a pure function over those
files — stateless, cacheable, and cheap. Replays are immutable after upload,
so derived summaries are computed once and cached per share.

### Layer 1 — agent-readable share links (implemented)

Content negotiation on the existing share route:

- `GET /r/<id>` with `Accept: text/markdown`, or `GET /r/<id>.md`, returns a
  rendered summary document: title, duration, URLs visited, step timeline,
  markers with notes, and the action list with failures highlighted. A footer
  documents the layer 2 endpoints so an agent can discover deeper queries.
- `GET /r/<id>.json` returns the structured `ReplaySummary`.

This makes every existing share link useful to any agent with generic web
fetch — no Replay MCP required — and is the first increment to ship.

### Layer 2 — scoped query API (implemented)

Endpoints keyed by share id only (never the underlying session id):

| Endpoint | Returns | Backed by |
| --- | --- | --- |
| `GET /v1/replays/:shareId/summary` | `ReplaySummary` | `summarizeReplay`, cached |
| `GET /v1/replays/:shareId/steps?from_ms&to_ms&marker&window_ms` | step slice | `stepsInRange` |
| `GET /v1/replays/:shareId/actions` | `AgentAction[]` | manifest passthrough |
| `GET /v1/replays/:shareId/markers` | `Marker[]` | manifest passthrough |
| `GET /v1/replays/:shareId/bundle` | the `.replay` artifact | on-demand spool export, served `no-store` so revocation stays meaningful |

`steps` takes either an explicit `[from_ms, to_ms]` window or a `marker` label
that centers a window of `window_ms` (default 10 s) on that marker.

All endpoints reuse the existing per-IP rate limiting and return 404 for
unknown or revoked shares. Revocation is a `revoked` flag on the share row in
`shares.json`; a revoked share 404s on `/r/`, on the query API, and on the
session data routes the player loads from, and re-uploading the same replay
mints a fresh share instead of resurrecting the revoked link.

### Layer 3 — MCP tools with a local deep-dive escape hatch (implemented)

New tools in `packages/mcp`, mechanical rather than magical (small predictable
tools translate across agent frameworks better than one fuzzy tool):

- `replay_overview(url)` — the markdown summary of a shared replay.
- `replay_steps(url, from_ms?, to_ms?, marker?, window_ms?)` — step slice.
- `replay_fetch(url)` — downloads the bundle via `/v1/replays/:shareId/bundle`
  and imports it into the local Replay home (`importSession`, idempotent).
  After that, every local capability works on the replay, including the
  player-backed `get_screen` and the in-player chat.

Tools accept the full share URL as pasted (agents receive links, not ids) and
derive the endpoint from it, so `REPLAY_SHARE_URL` is not required for
reading.

## Security and privacy

- The bearer-link model is unchanged: an unguessable share id grants read.
  Note the widening: today an id grants "watch in a browser"; after this slice
  it grants programmatic bulk extraction of the same data. Same data, easier
  reach — the phase 4A "use non-sensitive data" caveat applies with more
  force.
- A per-share `revoked` flag in `shares.json` (implemented) kills a link
  everywhere; flipping it is a manual `shares.json` edit until the revocation
  UI lands (deferred).
- Responses never expose session ids, spool paths, or other shares.
- Capture-time masking (passwords, script exclusion, >10 MiB asset exclusion)
  already bounds what is on disk, so the query API cannot leak anything the
  hosted player would not render.

## Deferred: the screen endpoint

A `GET /v1/replays/:shareId/screen?t_ms` endpoint (visible text and optionally
a PNG at a timestamp) is the natural completion of the query surface but is
excluded from this slice because it is the one piece that is not a pure
function over stored files: rrweb reconstruction needs a live DOM, which means
pooled headless Chromium on the share server — a heavyweight dependency,
real memory/CPU per request, seek latency, concurrency management, and a new
security surface from rendering recorded content server-side.

When it is built, the plan of record is: (a) reuse the daemon's existing
`get_screen` approach (`packages/daemon/src/chat.ts`) against a pooled hidden
player, behind a config flag defaulting to off; (b) ship reconstructed visible
text before pixels. Until then, `replay_fetch` is the escape hatch: an agent
that needs screen state pulls the bundle locally where `get_screen` already
works.

## Manual acceptance check

1. Share a small non-sensitive replay (phase 4A flow).
2. From a machine with no local Replay state, fetch `/r/<id>.md` with curl and
   verify the summary is coherent: steps, markers, actions, durations.
3. Ask a coding agent (no Replay MCP configured) to describe the recording
   given only the share URL; it should succeed via generic web fetch.
4. With Replay MCP configured, call `replay_overview` and `replay_steps` on
   the share URL and verify parity with the local summary of the same session.
5. Call `replay_fetch`, then use the local player and `get_screen` on the
   imported session.
6. Revoke the share and verify every endpoint, including `/r/<id>`, returns
   404.

## Deferred work

The screen endpoint (above); share expiry/TTL at upload time and a revocation
UI; network/console capture as a capture-side format extension; access control
and ownership (phase 4 umbrella); object storage for multi-instance serving.
