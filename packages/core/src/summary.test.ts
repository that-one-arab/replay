import test from "node:test";
import assert from "node:assert/strict";
import { renderSummaryText, stepsInRange, summarizeReplay } from "./summary.js";
import type { ReplayManifest } from "./types.js";

const BASE = 1_700_000_000_000;

function manifest(overrides: Partial<ReplayManifest> = {}): ReplayManifest {
  return {
    format_version: 1,
    id: "replay_test",
    title: "Checkout repro",
    created_at: "2026-07-19T10:00:00.000Z",
    capture: { version: "0", rrweb: "0", capture_canvas: false, capture_cross_origin_iframes: false },
    origins: ["http://127.0.0.1:4173"],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [{ id: "seg-1", page_url: "http://127.0.0.1:4173/", clock_offset_ms: 0, chunks: [] }],
    tab_events: [],
    markers: [],
    assets: [],
    ...overrides,
  };
}

function snapshotEvent(timestamp: number) {
  return {
    type: 2,
    timestamp,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [{
          type: 2,
          id: 10,
          tagName: "body",
          attributes: {},
          childNodes: [
            { type: 2, id: 11, tagName: "button", attributes: { id: "submit" }, childNodes: [{ type: 3, id: 12, textContent: "Place order" }] },
            { type: 2, id: 13, tagName: "input", attributes: { type: "email", placeholder: "Work email" }, childNodes: [] },
            { type: 2, id: 14, tagName: "input", attributes: { type: "checkbox", "aria-label": "Buy milk" }, childNodes: [] },
          ],
        }],
      },
    },
  };
}

test("summarizeReplay distills clicks, typing, markers, and idle gaps", () => {
  const events = [
    snapshotEvent(BASE),
    { type: 3, timestamp: BASE + 1_000, data: { source: 5, id: 13, text: "a" } },
    { type: 3, timestamp: BASE + 1_100, data: { source: 5, id: 13, text: "ab" } },
    { type: 3, timestamp: BASE + 1_200, data: { source: 5, id: 13, text: "ab@x.io" } },
    { type: 3, timestamp: BASE + 2_000, data: { source: 2, type: 2, id: 11, x: 5, y: 5 } },
    { type: 3, timestamp: BASE + 9_000, data: { source: 2, type: 2, id: 11, x: 5, y: 5 } },
  ];
  const summary = summarizeReplay(
    manifest({ markers: [{ t_ms: 2_000, label: "Submitting checkout", note: "expects a 500" }], raw_duration_ms: 9_000 }),
    new Map([["seg-1", events]]),
  );
  const descriptions = summary.steps.map((step) => step.description);
  assert.ok(descriptions.includes('Opened http://127.0.0.1:4173/'));
  assert.ok(descriptions.includes('Clicked button "Place order"'));
  assert.ok(descriptions.includes('Typed "ab@x.io" into email field "Work email"'), descriptions.join("\n"));
  assert.equal(descriptions.filter((item) => item.startsWith("Typed")).length, 1, "cumulative keystrokes collapse into one step");
  assert.ok(descriptions.some((item) => item.startsWith("Marker: Submitting checkout")));
  assert.ok(descriptions.some((item) => item.startsWith("Idle for 7")), "the 2s→9s gap surfaces as idle");
  assert.equal(summary.duration_ms, 9_000);
  const text = renderSummaryText(summary);
  assert.match(text, /Replay: Checkout repro/);
  assert.match(text, /t_ms=2000/);
});

test("summarizeReplay masks password-style values and folds checkbox toggles into their click", () => {
  const events = [
    snapshotEvent(BASE),
    // Text inputs carry isChecked: false noise from rrweb; they must stay typing steps.
    { type: 3, timestamp: BASE + 500, data: { source: 5, id: 13, text: "*****", isChecked: false } },
    { type: 3, timestamp: BASE + 900, data: { source: 2, type: 2, id: 14, x: 1, y: 1 } },
    { type: 3, timestamp: BASE + 950, data: { source: 5, id: 14, text: "on", isChecked: true } },
    // A programmatic checkbox update (no click nearby) is render noise, not a step.
    { type: 3, timestamp: BASE + 5_000, data: { source: 5, id: 14, text: "on", isChecked: false } },
  ];
  const summary = summarizeReplay(manifest(), new Map([["seg-1", events]]));
  const descriptions = summary.steps.map((step) => step.description);
  assert.ok(descriptions.some((item) => item.includes("Typed (masked)")), descriptions.join("\n"));
  assert.ok(descriptions.includes('Checked checkbox "Buy milk"'), descriptions.join("\n"));
  assert.ok(!descriptions.some((item) => item.startsWith("Clicked checkbox")), "the click folds into the toggle step");
  assert.ok(!descriptions.some((item) => item.startsWith("Unchecked")), "programmatic toggles are dropped");
});

test("stepsInRange windows the timeline and thinning keeps anchors", () => {
  const events = [
    snapshotEvent(BASE),
    ...Array.from({ length: 900 }, (_, index) => ({ type: 3, timestamp: BASE + 1_000 + index * 10, data: { source: 2, type: 2, id: 11, x: 1, y: 1 } })),
  ];
  const summary = summarizeReplay(
    manifest({ markers: [{ t_ms: 5_000, label: "Middle" }], raw_duration_ms: 12_000 }),
    new Map([["seg-1", events]]),
  );
  const windowed = stepsInRange(summary, 1_000, 1_100);
  assert.ok(windowed.length >= 1 && windowed.every((step) => step.t_ms >= 1_000 && step.t_ms <= 1_100));
  const text = renderSummaryText(summary, 50);
  assert.match(text, /Marker: Middle/, "markers survive thinning");
  assert.match(text, /routine steps elided/);
});

test("summarizeReplay reports navigations and tab switches", () => {
  const events = [snapshotEvent(BASE)];
  const summary = summarizeReplay(
    manifest({
      segments: [
        { id: "seg-1", page_url: "http://127.0.0.1:4173/", clock_offset_ms: 0, chunks: [] },
        { id: "seg-2", page_url: "http://127.0.0.1:4173/settings", clock_offset_ms: 4_000, chunks: [] },
      ],
      tab_events: [{ t_ms: 4_000, segment_id: "seg-2", type: "focused" }],
      navigation_events: [{ segment_id: "seg-1", kind: "navigate", started_at_ms: 2_000, committed_at_ms: 2_100, ready_at_ms: 2_200, from_url: "http://127.0.0.1:4173/", to_url: "http://127.0.0.1:4173/cart" }],
    }),
    new Map([["seg-1", events], ["seg-2", []]]),
  );
  const descriptions = summary.steps.map((step) => step.description);
  assert.ok(descriptions.some((item) => item.includes("Navigated from") && item.includes("/cart")));
  assert.ok(descriptions.some((item) => item.includes("Switched to tab") && item.includes("/settings")));
  assert.equal(summary.tab_count, 2);
});
