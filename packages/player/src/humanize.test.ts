import assert from "node:assert/strict";
import test from "node:test";
import type { ReplayEvent } from "./types.js";
import { CURSOR_APPROACH_MS, CURSOR_DWELL_MS, KEYSTROKE_PACE_MS, humanizeEvents, withCursorLeadIns } from "./humanize.js";

const input = (timestamp: number, id: number, text: string): ReplayEvent => ({ type: 3, timestamp, data: { source: 5, id, text } });
const clickAt = (timestamp: number, x: number, y: number): ReplayEvent => ({ type: 3, timestamp, data: { source: 2, type: 2, x, y } });

test("a batch fill is dramatized character by character", () => {
  const out = humanizeEvents([{ type: 2, timestamp: 0 }, input(1_000, 7, "hey")]);
  const fills = out.filter((event) => event.data?.source === 5);
  assert.deepEqual(fills.map((event) => event.data?.text), ["h", "he", "hey"]);
  assert.deepEqual(fills.map((event) => event.timestamp), [1, 2, 3].map((step) => 1_000 + step * KEYSTROKE_PACE_MS));
});

test("incremental keystrokes are paced in place, not re-dramatized", () => {
  const out = humanizeEvents([{ type: 2, timestamp: 0 }, input(1_000, 7, "hey"), input(1_300, 7, "heyo")]);
  const full = out.filter((event) => event.data?.text === "heyo");
  assert.equal(full.length, 1);
  // The batch fill added 3 keystrokes of delay; the follow-up keeps its own
  // (shifted) slot because it already falls after the pacing cursor.
  assert.equal(full[0]!.timestamp, 1_300 + 3 * KEYSTROKE_PACE_MS);
});

test("checkbox values pass through unchanged", () => {
  const out = humanizeEvents([{ type: 2, timestamp: 0 }, input(1_000, 9, "on")]);
  const fills = out.filter((event) => event.data?.source === 5);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.data?.text, "on");
  assert.equal(fills[0]!.timestamp, 1_000);
});

test("raw driver mouse-move streams are dropped", () => {
  const out = humanizeEvents([
    { type: 2, timestamp: 0 },
    { type: 3, timestamp: 100, data: { source: 1, positions: [{ x: 5, y: 5 }] } },
  ]);
  assert.equal(out.some((event) => event.data?.source === 1), false);
});

test("an approach glide is synthesized between distant pointer targets", () => {
  const out = humanizeEvents([{ type: 2, timestamp: 0 }, clickAt(500, 100, 100), clickAt(2_000, 400, 300)]);
  const approach = out.find((event) => event.data?.replaySynthetic === "approach");
  assert.ok(approach, "expected a synthetic approach before the second click");
  assert.equal(approach!.timestamp, 2_000 - CURSOR_APPROACH_MS);
  const last = approach!.data!.positions!.at(-1)!;
  assert.equal(last.x, 400);
  assert.equal(last.y, 300);
  // No approach before the first click: the cursor has no origin to travel from.
  assert.ok(out.indexOf(approach!) > out.findIndex((event) => event.timestamp === 500 && event.data?.source === 2));
});

test("withCursorLeadIns inserts a cue one approach-plus-dwell ahead of a click", () => {
  const click: ReplayEvent = { type: 3, timestamp: 5_000, data: { source: 2, type: 2, id: 3, x: 0, y: 0 } };
  const out = withCursorLeadIns([{ type: 2, timestamp: 0 }, click]);
  assert.equal(out.length, 3);
  const cue = out[1]!;
  assert.equal(cue.type, 5);
  assert.equal(cue.data?.tag, "replay-cursor");
  assert.equal(cue.data?.id, 3);
  assert.equal(cue.timestamp, 5_000 - CURSOR_APPROACH_MS - CURSOR_DWELL_MS);
});

test("withCursorLeadIns skips the cue when there is no room before the click", () => {
  const out = withCursorLeadIns([
    { type: 2, timestamp: 4_995 },
    { type: 3, timestamp: 5_000, data: { source: 2, type: 2, id: 3, x: 0, y: 0 } },
  ]);
  assert.equal(out.length, 2);
});
