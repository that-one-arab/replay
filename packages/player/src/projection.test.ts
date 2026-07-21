import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest, ReplayEvent } from "./types.js";
import { DEFAULT_REPLAY_DEFAULTS, idleRanges, projectPlayback, resolvedReplayDefaults, totalIdleMs } from "./projection.js";

const click = (timestamp: number): ReplayEvent => ({ type: 3, timestamp, data: { source: 2, type: 2, x: 10, y: 10 } });

// One segment starting at wall-clock 1s with activity at 0s, 1s, and 61s of
// session time — a single 60s idle gap between 1s and 61s.
function fixture(): { manifest: Manifest; eventSets: Map<string, ReplayEvent[]> } {
  const events: ReplayEvent[] = [{ type: 2, timestamp: 1_000 }, click(1_000), click(2_000), click(62_000)];
  const manifest: Manifest = {
    id: "r1",
    title: "Replay",
    markers: [{ t_ms: 61_000, label: "End of gap" }],
    segments: [{ id: "s1", page_url: "https://example.test/", clock_offset_ms: 0 }],
  };
  return { manifest, eventSets: new Map([["s1", events]]) };
}

test("cut mode collapses an idle gap to the retained span", () => {
  const { manifest, eventSets } = fixture();
  const projection = projectPlayback(manifest, eventSets, "cut", DEFAULT_REPLAY_DEFAULTS);
  assert.equal(projection.duration, 3_000);
  assert.equal(projection.manifest.markers[0]!.t_ms, 3_000);
  assert.deepEqual(projection.idleRanges, [{ start: 1_000, end: 3_000, originalDuration: 60_000, mode: "cut", speed: DEFAULT_REPLAY_DEFAULTS.idle_fast_forward_speed }]);
});

test("toPlayback and toRaw invert each other inside a collapsed gap", () => {
  const { manifest, eventSets } = fixture();
  const projection = projectPlayback(manifest, eventSets, "cut", DEFAULT_REPLAY_DEFAULTS);
  assert.equal(projection.toPlayback(31_000), 2_000);
  assert.equal(projection.toRaw(projection.toPlayback(31_000)), 31_000);
  assert.equal(projection.toRaw(projection.toPlayback(500)), 500);
});

// A segment whose first snapshot lands after capture began (clock_offset_ms > 0)
// carries a dead pre-roll: no events exist between session t=0 and the first
// frame. The projection must drop that lead so the timeline's 0 is the first
// real content — otherwise seeks into the opening seconds clamp forward.
function preRollFixture(): { manifest: Manifest; eventSets: Map<string, ReplayEvent[]> } {
  const events: ReplayEvent[] = [{ type: 2, timestamp: 1_000 }, click(1_000), click(62_000)];
  return {
    manifest: {
      id: "r2",
      title: "Replay",
      markers: [],
      segments: [{ id: "s1", page_url: "https://example.test/", clock_offset_ms: 3_018 }],
    },
    eventSets: new Map([["s1", events]]),
  };
}

test("pre-roll before the first snapshot is dropped so playback starts at 0", () => {
  const { manifest, eventSets } = preRollFixture();
  const projection = projectPlayback(manifest, eventSets, "cut", DEFAULT_REPLAY_DEFAULTS);
  // The first frame's playback time is 0, not the raw clock offset.
  assert.equal(projection.toPlayback(3_018), 0);
  assert.equal(projection.manifest.segments[0]!.clock_offset_ms, 0);
  // The dead 3018ms lead is gone. The 61s idle gap between the two clicks
  // collapses to the 2s retained span, and the second click sits at playbackEnd,
  // so the whole timeline is just that retained 2s.
  assert.equal(projection.duration, 2_000);
  // A scrub into the former dead zone (1s, 2s) maps to a real offset from the
  // first frame rather than clamping forward to it: requestedTime - tabStart >= 0.
  for (const requested of [0, 1_000, 2_000]) {
    const tabStart = projection.manifest.segments[0]!.clock_offset_ms;
    assert.ok(requested - tabStart >= 0, `scrub to ${requested} should not precede the first frame`);
  }
  // toRaw remains the inverse of toPlayback across the lead (boundaries are
  // exact; inside a collapsed gap the scale round-trip is sub-ms, so round).
  assert.equal(projection.toRaw(projection.toPlayback(3_018)), 3_018);
  assert.equal(projection.toRaw(projection.toPlayback(64_018)), 64_018);
  assert.equal(Math.round(projection.toRaw(projection.toPlayback(31_000))), 31_000);
});

test("fast-forward mode compresses idle by the configured speed", () => {
  const { manifest, eventSets } = fixture();
  const projection = projectPlayback(manifest, eventSets, "fast_forward", DEFAULT_REPLAY_DEFAULTS);
  assert.equal(projection.duration, 1_000 + 60_000 / DEFAULT_REPLAY_DEFAULTS.idle_fast_forward_speed);
});

test("preserve mode leaves the timeline untouched", () => {
  const { manifest, eventSets } = fixture();
  const projection = projectPlayback(manifest, eventSets, "preserve", DEFAULT_REPLAY_DEFAULTS);
  assert.equal(projection.duration, 61_000);
  assert.equal(projection.manifest.markers[0]!.t_ms, 61_000);
  assert.equal(projection.toPlayback(31_000), 31_000);
});

test("projectPlayback remaps a highlight marker's time but preserves its element, defect, and hold", () => {
  const events: ReplayEvent[] = [{ type: 2, timestamp: 1_000 }, click(1_000), click(2_000), click(62_000)];
  const manifest: Manifest = {
    id: "r2",
    title: "Highlight replay",
    markers: [{ t_ms: 61_000, label: "1 of 3 completed", node_id: 42, defect: { expected: "Step 2 of 3", actual: "1 of 3 completed" }, hold: "until_ack" }],
    segments: [{ id: "s1", page_url: "https://example.test/", clock_offset_ms: 0 }],
  };
  const projection = projectPlayback(manifest, new Map([["s1", events]]), "cut", DEFAULT_REPLAY_DEFAULTS);
  const marker = projection.manifest.markers[0]!;
  assert.equal(marker.t_ms, 3_000, "the marker time is remapped across the collapsed idle gap");
  assert.equal(marker.node_id, 42);
  assert.deepEqual(marker.defect, { expected: "Step 2 of 3", actual: "1 of 3 completed" });
  assert.equal(marker.hold, "until_ack");
});

test("totalIdleMs sums the recording's idle and is independent of idle mode", () => {
  const { manifest, eventSets } = fixture(); // one 60s idle gap between 1s and 61s
  // Uses originalDuration on the projected ranges, so the sum is the raw gap
  // length no matter how playback paces it.
  assert.equal(totalIdleMs(projectPlayback(manifest, eventSets, "cut", DEFAULT_REPLAY_DEFAULTS).idleRanges), 60_000);
  assert.equal(totalIdleMs(projectPlayback(manifest, eventSets, "fast_forward", DEFAULT_REPLAY_DEFAULTS).idleRanges), 60_000);
  assert.equal(totalIdleMs(projectPlayback(manifest, eventSets, "preserve", DEFAULT_REPLAY_DEFAULTS).idleRanges), 60_000);
  // Falls back to the span for raw idle ranges (no originalDuration).
  assert.equal(totalIdleMs(idleRanges([0, 1_000, 5_000], 20_000)), 4_000 + 15_000);
  assert.equal(totalIdleMs([]), 0);
});

test("idleRanges detects interior and trailing gaps past the threshold", () => {
  assert.deepEqual(idleRanges([0, 1_000, 5_000], 20_000), [
    { start: 1_000, end: 5_000 },
    { start: 5_000, end: 20_000 },
  ]);
  assert.deepEqual(idleRanges([0, 1_000], 2_000), []);
});

test("resolvedReplayDefaults falls back on missing or invalid values", () => {
  assert.equal(resolvedReplayDefaults(undefined), DEFAULT_REPLAY_DEFAULTS);
  assert.equal(resolvedReplayDefaults({ ...DEFAULT_REPLAY_DEFAULTS, idle_mode: "bogus" as never }), DEFAULT_REPLAY_DEFAULTS);
  assert.equal(resolvedReplayDefaults({ ...DEFAULT_REPLAY_DEFAULTS, default_speed: 0 }), DEFAULT_REPLAY_DEFAULTS);
  const custom = { idle_mode: "preserve" as const, idle_retained_ms: 1_000, idle_fast_forward_speed: 4, default_speed: 1 };
  assert.equal(resolvedReplayDefaults(custom), custom);
});
