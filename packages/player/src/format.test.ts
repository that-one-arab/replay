import assert from "node:assert/strict";
import test from "node:test";
import { clamp, escape, format, formatDuration, formatSaved, nearlyEqual } from "./format.js";

test("formatSaved renders sub-minute idle as seconds and longer idle as m:ss", () => {
  assert.equal(formatSaved(0), "0s");
  assert.equal(formatSaved(12_000), "12s");
  assert.equal(formatSaved(59_499), "59s"); // rounds down at the boundary
  assert.equal(formatSaved(60_000), "1m 00s");
  assert.equal(formatSaved(135_000), "2m 15s");
});

test("format renders a clock readout and zeroes out empty input", () => {
  assert.equal(format(), "0:00");
  assert.equal(format(0), "0:00");
  assert.equal(format(65_000), "1:05");
});

test("formatDuration keeps one decimal under 10s and drops it above", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(3_400), "3.4s");
  assert.equal(formatDuration(45_000), "45s");
});

test("clamp and nearlyEqual behave at the boundaries", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(nearlyEqual(0, 3), false); // 3ms apart exceeds the 2ms threshold
  assert.equal(nearlyEqual(1, 1.5), true);
});

test("escape neutralizes characters meaningful in element and attribute contexts", () => {
  assert.equal(escape(`a & <b> "c" 'd'`), "a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;");
});
