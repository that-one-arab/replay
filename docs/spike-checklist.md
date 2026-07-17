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
recording. The player currently opens the first segment; the popup proves capture
correctness, while segment switching is a follow-on player feature.

### Phase 1 decisions

- Add an asset proxy/bundler before claiming offline or self-contained external
  asset fidelity.
- Add a deliberate cross-origin iframe strategy (bridge/plugin or visible fallback)
  before treating those frames as replayable.
- Enable and evaluate canvas recording only after weighing bundle size and privacy
  implications.
- Preserve a short post-navigation settle interval in agent recording guidance.
