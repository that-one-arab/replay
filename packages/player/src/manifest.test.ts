import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest, ReplayEvent } from "./types.js";
import { describeAction, eventEndTime, recordingViewport, resolveMarkerTimes, segmentAtTime, segmentLabel, tabEvents } from "./manifest.js";

function twoTabManifest(): { manifest: Manifest; eventSets: Map<string, ReplayEvent[]> } {
  const manifest: Manifest = {
    id: "r1",
    title: "Recording",
    markers: [],
    segments: [
      { id: "s1", page_url: "https://example.test/", clock_offset_ms: 0 },
      { id: "s2", page_url: "https://example.test/checkout", clock_offset_ms: 10_000 },
    ],
    tab_events: [
      { type: "opened", segment_id: "s1", t_ms: 0 },
      { type: "focused", segment_id: "s1", t_ms: 0 },
      { type: "opened", segment_id: "s2", t_ms: 10_000 },
      { type: "focused", segment_id: "s2", t_ms: 10_000 },
      { type: "closed", segment_id: "s2", t_ms: 15_000 },
    ],
  };
  const eventSets = new Map<string, ReplayEvent[]>([
    ["s1", [{ type: 2, timestamp: 0 }, { type: 3, timestamp: 20_000, data: { source: 2, type: 2 } }]],
    ["s2", [{ type: 2, timestamp: 0 }, { type: 3, timestamp: 4_000, data: { source: 2, type: 2 } }]],
  ]);
  return { manifest, eventSets };
}

test("segmentAtTime follows tab focus and skips closed tabs", () => {
  const { manifest, eventSets } = twoTabManifest();
  assert.equal(segmentAtTime(manifest, eventSets, 5_000)?.id, "s1");
  assert.equal(segmentAtTime(manifest, eventSets, 12_000)?.id, "s2");
  // s2 is closed at 15s; focus falls back to the still-open s1.
  assert.equal(segmentAtTime(manifest, eventSets, 16_000)?.id, "s1");
});

test("tabEvents synthesizes opened+focused pairs when the manifest predates tab capture", () => {
  const { manifest } = twoTabManifest();
  const legacy: Manifest = { ...manifest, tab_events: [] };
  assert.deepEqual(tabEvents(legacy), [
    { type: "opened", segment_id: "s1", t_ms: 0 },
    { type: "focused", segment_id: "s1", t_ms: 0 },
    { type: "opened", segment_id: "s2", t_ms: 10_000 },
    { type: "focused", segment_id: "s2", t_ms: 10_000 },
  ]);
});

test("eventEndTime spans to the last event across segments", () => {
  const { manifest, eventSets } = twoTabManifest();
  assert.equal(eventEndTime(manifest, eventSets), 20_000);
});

test("resolveMarkerTimes snaps markers to the nearest visible step", () => {
  const manifest: Manifest = {
    id: "r1",
    title: "Recording",
    segments: [{ id: "s1", page_url: "https://example.test/", clock_offset_ms: 0 }],
    markers: [
      { t_ms: 2_500, label: "back" },
      { t_ms: 2_500, label: "forward", placement: "before_next" },
      { t_ms: 9_000, label: "beyond", placement: "before_next" },
    ],
  };
  const eventSets = new Map<string, ReplayEvent[]>([["s1", [
    { type: 2, timestamp: 0 },
    { type: 3, timestamp: 1_000, data: { source: 2, type: 2 } },
    { type: 3, timestamp: 3_000, data: { source: 5, text: "x" } },
  ]]]);
  const resolved = resolveMarkerTimes(manifest, eventSets);
  assert.equal(resolved[0]!.t_ms, 1_000);
  assert.equal(resolved[1]!.t_ms, 3_000);
  // No step at or after the marker: it keeps its authored time.
  assert.equal(resolved[2]!.t_ms, 9_000);
});

test("resolveMarkerTimes anchors action-bound markers on the action's own bracket", () => {
  const manifest: Manifest = {
    id: "r1",
    title: "Recording",
    segments: [{ id: "s1", page_url: "https://example.test/", clock_offset_ms: 0 }],
    actions: [
      { id: "a1", tool: "browser_click", started_at_ms: 900, finished_at_ms: 3_500, ok: true },
      { id: "a2", tool: "browser_wait_for", started_at_ms: 5_000, finished_at_ms: 6_000, ok: true },
    ],
    markers: [
      { t_ms: 3_600, label: "clicked", action_id: "a1" },
      { t_ms: 6_100, label: "waited", action_id: "a2" },
      { t_ms: 100, label: "unknown binding", action_id: "missing" },
    ],
  };
  const eventSets = new Map<string, ReplayEvent[]>([["s1", [
    { type: 2, timestamp: 0 },
    { type: 3, timestamp: 1_000, data: { source: 2, type: 2 } },
    { type: 3, timestamp: 3_000, data: { source: 5, text: "x" } },
  ]]]);
  const resolved = resolveMarkerTimes(manifest, eventSets);
  // The last visible step the action caused, inside its bracket.
  assert.equal(resolved[0]!.t_ms, 3_000);
  // No step inside the bracket: the action's completion anchors the marker.
  assert.equal(resolved[1]!.t_ms, 6_000);
  // A binding to an unknown action falls back to ordinary snapping.
  assert.equal(resolved[2]!.t_ms, 100);
});

test("describeAction renders a compact caption from the tool and its first argument", () => {
  assert.equal(describeAction({ id: "a1", tool: "browser_click", args_summary: "{\"selector\":\"#submit\"}", started_at_ms: 0, finished_at_ms: 1, ok: true }), "click · #submit");
  assert.equal(describeAction({ id: "a2", tool: "browser_wait_for", started_at_ms: 0, finished_at_ms: 1, ok: true }), "wait for");
  assert.equal(describeAction({ id: "a3", tool: "browser_navigate", args_summary: "not json", started_at_ms: 0, finished_at_ms: 1, ok: false }), "navigate · not json (failed)");
  const long = describeAction({ id: "a4", tool: "browser_type", args_summary: JSON.stringify({ text: "x".repeat(80) }), started_at_ms: 0, finished_at_ms: 1, ok: true });
  assert.ok(long.length < 75 && long.endsWith("…"));
});

test("segmentLabel shortens URLs to host and path", () => {
  assert.equal(segmentLabel("https://example.test/"), "example.test");
  assert.equal(segmentLabel("https://example.test/checkout"), "example.test/checkout");
  assert.equal(segmentLabel("not a url"), "not a url");
});

test("recordingViewport reads the meta event and falls back to 1280x720", () => {
  assert.deepEqual(recordingViewport([{ type: 4, timestamp: 0, data: { width: 900, height: 600 } }]), { width: 900, height: 600 });
  assert.deepEqual(recordingViewport([{ type: 2, timestamp: 0 }]), { width: 1280, height: 720 });
});
