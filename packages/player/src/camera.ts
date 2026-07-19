/**
 * The auto-zoom camera: eases toward recent interactions, follows the cursor
 * while zoomed, holds for a beat, then pulls back to the full frame. It owns
 * the replay wrapper's transform.
 */
import type { Replayer } from "@rrweb/replay";
import { clamp } from "./format.js";

const CAMERA_ZOOM = 1.45;
const CAMERA_HOLD_MS = 3_800;
const CAMERA_EASE_PER_S = 4.2;

export function createCamera(mount: HTMLElement, replayer: Replayer, viewport: { width: number; height: number }, lifetime: AbortController, initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  let zoom = 1;
  let targetZoom = 1;
  let focusX = viewport.width / 2;
  let focusY = viewport.height / 2;
  let targetX = focusX;
  let targetY = focusY;
  let holdTimer: number | undefined;
  let frame: number | undefined;
  let lastTick = 0;
  const apply = () => {
    const base = Math.min(mount.clientWidth / viewport.width, mount.clientHeight / viewport.height);
    // transform-origin is the wrapper center: translating by (center - focus)
    // in content pixels before scaling lands the focus point mid-stage.
    replayer.wrapper.style.transform = `scale(${base * zoom}) translate(${viewport.width / 2 - focusX}px, ${viewport.height / 2 - focusY}px)`;
  };
  const schedule = () => {
    if (frame !== undefined || lifetime.signal.aborted) return;
    lastTick = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    frame = undefined;
    const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
    lastTick = now;
    const blend = 1 - Math.exp(-CAMERA_EASE_PER_S * dt);
    zoom += (targetZoom - zoom) * blend;
    focusX += (targetX - focusX) * blend;
    focusY += (targetY - focusY) * blend;
    // Hard clamp at the in-flight zoom so the frame never pans past an edge.
    const halfW = viewport.width / (2 * zoom);
    const halfH = viewport.height / (2 * zoom);
    focusX = clamp(focusX, halfW, viewport.width - halfW);
    focusY = clamp(focusY, halfH, viewport.height - halfH);
    apply();
    if (Math.abs(zoom - targetZoom) > 0.001 || Math.abs(focusX - targetX) > 0.5 || Math.abs(focusY - targetY) > 0.5) schedule();
  };
  const setFocusTarget = (x: number, y: number) => {
    const halfW = viewport.width / (2 * targetZoom);
    const halfH = viewport.height / (2 * targetZoom);
    targetX = clamp(x, halfW, viewport.width - halfW);
    targetY = clamp(y, halfH, viewport.height - halfH);
  };
  const zoomOut = () => {
    targetZoom = 1;
    setFocusTarget(viewport.width / 2, viewport.height / 2);
    schedule();
  };
  const armHold = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(zoomOut, CAMERA_HOLD_MS);
  };
  const noteInteraction = (x: number, y: number) => {
    if (!enabled) return;
    targetZoom = CAMERA_ZOOM;
    setFocusTarget(x, y);
    armHold();
    schedule();
  };
  const trackCursor = (x: number, y: number) => {
    if (!enabled || targetZoom === 1) return;
    setFocusTarget(x, y);
    schedule();
  };
  const refreshHold = () => {
    if (!enabled || targetZoom === 1) return;
    armHold();
  };
  const reset = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = undefined;
    zoomOut();
  };
  const setPlaying = (value: boolean) => {
    // The hold window is wall-clock; freeze it while paused so a paused
    // inspection stays framed, and rearm it on resume.
    if (!value) { if (holdTimer) window.clearTimeout(holdTimer); holdTimer = undefined; }
    else if (targetZoom > 1) armHold();
  };
  const setEnabled = (value: boolean) => {
    enabled = value;
    if (!value) reset();
  };
  lifetime.signal.addEventListener("abort", () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (holdTimer) window.clearTimeout(holdTimer);
  }, { once: true });
  apply();
  return { apply, noteInteraction, trackCursor, refreshHold, reset, setPlaying, setEnabled };
}
