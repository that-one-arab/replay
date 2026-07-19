/**
 * Detects when a headed browser's emulated viewport is larger than the display
 * it is shown on. Playwright drives Rec's managed Chrome with an
 * Emulation.setDeviceMetricsOverride, so a page can report an inner size wider
 * or taller than the physical window — Chrome then paints the overflow
 * off-screen and the visible page looks "zoomed in" with edges cut off. This is
 * pure logic over a single measurement so it can be unit-tested away from a
 * live browser; the recorder feeds it real numbers from `page.evaluate`.
 */

/** A single reading taken from the live page (all in CSS pixels). */
export interface ViewportMeasurement {
  /** The emulated layout viewport — reflects any device-metrics override. */
  innerWidth: number;
  innerHeight: number;
  /** The physical display work area, unaffected by a viewport override. */
  screenAvailWidth: number;
  screenAvailHeight: number;
  devicePixelRatio: number;
}

export interface ViewportFit {
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  devicePixelRatio: number;
  /** True when the emulated viewport spills past the usable display. */
  clipped: boolean;
  /** The largest safe viewport for this display; present only when clipped. */
  recommendedViewport?: { width: number; height: number };
  /** Human-readable explanation; present only when clipped. */
  warning?: string;
}

// A viewport within a pixel of the display is not a real overflow — sub-pixel
// rounding and device-scale conversions routinely differ by ~1px.
const CLIP_TOLERANCE_PX = 1;
// Reserve room for the window frame the emulated viewport must live inside: side
// borders and a scrollbar horizontally, the title bar vertically. Approximate;
// the goal is a recommendation that comfortably fits, not a pixel-exact one.
const FRAME_MARGIN_WIDTH_PX = 16;
const FRAME_MARGIN_HEIGHT_PX = 40;
// Never recommend a viewport too small to be usable, even on a tiny display.
const MIN_RECOMMENDED_PX = 320;

export function evaluateViewportFit(measurement: ViewportMeasurement): ViewportFit {
  const viewport = { width: Math.round(measurement.innerWidth), height: Math.round(measurement.innerHeight) };
  const screen = { width: Math.round(measurement.screenAvailWidth), height: Math.round(measurement.screenAvailHeight) };
  // A zero/unknown screen reading (some headless or detached targets) can't tell
  // us anything reliable, so never raise a false clip alarm from it.
  const screenKnown = screen.width > 0 && screen.height > 0;
  const overflowsWidth = screenKnown && viewport.width > screen.width + CLIP_TOLERANCE_PX;
  const overflowsHeight = screenKnown && viewport.height > screen.height + CLIP_TOLERANCE_PX;
  const base: ViewportFit = { viewport, screen, devicePixelRatio: measurement.devicePixelRatio, clipped: overflowsWidth || overflowsHeight };
  if (!base.clipped) return base;
  const recommendedViewport = {
    width: Math.max(MIN_RECOMMENDED_PX, screen.width - FRAME_MARGIN_WIDTH_PX),
    height: Math.max(MIN_RECOMMENDED_PX, screen.height - FRAME_MARGIN_HEIGHT_PX),
  };
  const warning =
    `Browser viewport ${viewport.width}×${viewport.height} exceeds the display ${screen.width}×${screen.height}; ` +
    `content will render off-screen (looks zoomed in / cut off). ` +
    `Resize the viewport to ${recommendedViewport.width}×${recommendedViewport.height} or smaller.`;
  return { ...base, recommendedViewport, warning };
}
