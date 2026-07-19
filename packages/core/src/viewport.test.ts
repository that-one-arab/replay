import test from "node:test";
import assert from "node:assert/strict";
import { evaluateViewportFit, type ViewportMeasurement } from "./viewport.js";

function measurement(overrides: Partial<ViewportMeasurement> = {}): ViewportMeasurement {
  return { innerWidth: 1280, innerHeight: 720, screenAvailWidth: 1512, screenAvailHeight: 916, devicePixelRatio: 1, ...overrides };
}

test("a viewport within the display is not clipped and gets no recommendation", () => {
  const fit = evaluateViewportFit(measurement());
  assert.equal(fit.clipped, false);
  assert.equal(fit.recommendedViewport, undefined);
  assert.equal(fit.warning, undefined);
  assert.deepEqual(fit.viewport, { width: 1280, height: 720 });
  assert.deepEqual(fit.screen, { width: 1512, height: 916 });
});

test("a viewport wider than the display clips and is told to shrink to fit", () => {
  const fit = evaluateViewportFit(measurement({ innerWidth: 1600, innerHeight: 900 }));
  assert.equal(fit.clipped, true);
  // 1512 avail − 16px frame margin = 1496 usable width.
  assert.deepEqual(fit.recommendedViewport, { width: 1496, height: 876 });
  assert.match(String(fit.warning), /1600×900 exceeds the display 1512×916/);
  assert.match(String(fit.warning), /1496×876 or smaller/);
});

test("a viewport taller than the display clips even when it fits horizontally", () => {
  const fit = evaluateViewportFit(measurement({ innerWidth: 1280, innerHeight: 1000 }));
  assert.equal(fit.clipped, true);
  assert.ok(fit.recommendedViewport);
});

test("a one-pixel overshoot is tolerated as rounding, not a clip", () => {
  const fit = evaluateViewportFit(measurement({ innerWidth: 1513, innerHeight: 916 }));
  assert.equal(fit.clipped, false);
});

test("an unknown (zero) display never raises a false clip alarm", () => {
  const fit = evaluateViewportFit(measurement({ screenAvailWidth: 0, screenAvailHeight: 0 }));
  assert.equal(fit.clipped, false);
  assert.equal(fit.recommendedViewport, undefined);
});

test("the recommendation never drops below a usable floor on a tiny display", () => {
  const fit = evaluateViewportFit(measurement({ innerWidth: 800, innerHeight: 600, screenAvailWidth: 300, screenAvailHeight: 200 }));
  assert.equal(fit.clipped, true);
  assert.deepEqual(fit.recommendedViewport, { width: 320, height: 320 });
});

test("measurements are rounded to whole pixels", () => {
  const fit = evaluateViewportFit(measurement({ innerWidth: 1279.6, innerHeight: 719.4 }));
  assert.deepEqual(fit.viewport, { width: 1280, height: 719 });
});
