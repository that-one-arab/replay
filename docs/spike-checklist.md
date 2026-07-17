# Phase 0 spike checklist

1. Launch Chrome with `rec browser start`; drive it through a second CDP client.
2. Start recording after a page has already loaded, navigate twice, and stop.
3. Open the replay and compare the initial state, a form interaction, and final UI.
4. Add a marker before the important interaction and confirm it appears in the rail.
5. Record an intentionally idle interval; compare `raw_duration_ms` to
   `active_duration_ms`.
6. Record a popup/new tab and note whether it is captured as a separate segment.
7. Record an app with an external stylesheet/font and grade fidelity.

Record the results, exact rrweb pin, browser version, bytes/minute, and any fallback
decision in the issue that owns the spike.

## Local evidence (Phase 0)

Environment: `rrweb` recorder `2.0.0-alpha.20`, `playwright-core` `1.61.1`,
Chrome `150.0.7871.124`, local commit `e2e579b`.

| Check | Result | Evidence |
| --- | --- | --- |
| Secondary CDP client | Pass | The deterministic demos drive Chrome through a separate Playwright CDP connection while `rec` is attached. |
| Start after page load; navigate twice | Pass with a settle interval | `rec_a592de96` contains three metadata/full-snapshot pairs for `/start`, `/first`, and `/second`. Rapid back-to-back navigation coalesces to the last page, so agent workflows should wait for a page to settle before navigating again. |
| Initial, interaction, and final replay state | Pass | `rec_97675064` captures the deterministic Orbit journey (115 events in the main segment). |
| Markers | Pass | The Orbit replay includes seven labelled checkpoints, including the idle and popup milestones. |
| Idle compression | Pass | `rec_97675064` reports 45,458 ms raw versus 35,561 ms active. At 8x, Skip idle on finished in about 2.3 s; disabled, replay was still playing at 0:21 after the same elapsed time. |
| Popup/new tab segmentation | Pass | `rec_97675064` has `seg_1` for onboarding (14,308 bytes, 115 events) and `seg_2` for `/invite-preview` (2,915 bytes, 11 events). |
| Same-origin iframe | Pass | `rec_a83cacd3` includes the iframe mutation `Frame changed`. |
| External CSS/image, cross-origin iframe, canvas | Expected limitation | In poisoned-resource replay probe `rec_5e8c72d0`, replay made fresh requests for `/probe.css` and `/image.svg`; canvas pixels were not serialized; the cross-origin frame mutation was not serialized. |

The full Orbit bundle was 17,223 bytes, or about 22,733 bytes/minute of raw
recording.

## Phase 1 implementation

| Area | Implementation | Boundaries |
| --- | --- | --- |
| Segments | The player presents each captured page/popup as a selectable page and keeps its timeline and markers local to that segment. | A segment is still one page target; fast navigation should retain the Phase 0 settle interval. |
| Static assets | Stylesheets, images, and fonts already loaded by the page—and those loaded while recording—are stored by SHA-256 in `assets/` and event URLs are rewritten to the local replay endpoint. CSS `url(...)` dependencies are captured recursively. | Scripts, API responses, inaccessible protected resources, and resources over 10 MiB are not copied. |
| Cross-origin iframes | Supplying both origins starts rrweb’s cross-origin iframe bridge. An iframe whose origin is outside the allowlist is persisted as a visible “External frame unavailable” placeholder, never as a live replay request. | The embedding application must allow the rrweb injection; otherwise the placeholder remains the safe outcome. |
| Canvas | `rec start --record-canvas` enables rrweb canvas mutation capture and writes the choice into the manifest. It is disabled by default. | Canvas pixels can be sensitive and can materially increase bundle size; use only for a reviewed scope. |

The Phase 0 post-navigation settle guidance remains in force.

Local Phase 1 smoke evidence: `rec_206e9a34` has two populated segments and
bundles the Orbit stylesheet (`text/css`, 83 bytes) and logo (`image/svg+xml`,
183 bytes). The replay event stream references the local session asset endpoint;
neither original asset URL remains in the persisted event stream.
