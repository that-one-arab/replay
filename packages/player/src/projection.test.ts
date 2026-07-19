import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest, ReplayEvent } from "./types.js";
import { DEFAULT_REPLAY_DEFAULTS, idleRanges, projectPlayback, resolvedReplayDefaults } from "./projection.js";

const click = (timestamp: number): ReplayEvent => ({ type: 3, timestamp, data: { source: 2, type: 2, x: 10, y: 10 } });

// One segment starting at wall-clock 1s with activity at 0s, 1s, and 61s of
// session time — a single 60s idle gap between 1s and 61s.
function fixture(): { manifest: Manifest; eventSets: Map<string, ReplayEvent[]> } {
  const events: ReplayEvent[] = [{ type: 2, timestamp: 1_000 }, click(1_000), click(2_000), click(62_000)];
  const manifest: Manifest = {
    id: "r1",
    title: "Recording",
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
