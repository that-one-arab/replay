import assert from "node:assert/strict";
import test from "node:test";
import { calculateActiveDuration } from "./storage.js";

test("caps inactive gaps while preserving active event spans", () => {
  assert.equal(calculateActiveDuration([0, 1_000, 8_000]), 4_000);
});

test("returns zero for a single timestamp", () => {
  assert.equal(calculateActiveDuration([1_000]), 0);
});
