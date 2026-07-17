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
