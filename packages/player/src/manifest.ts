/**
 * Pure derivations over the manifest and its event sets: timeline activity,
 * navigation and tab metadata, marker resolution, and segment lookup. No DOM.
 */
import { EventType, IncrementalSource, type AgentAction, type Manifest, type NavigationEvent, type ReplayEvent } from "./types.js";
import { clamp } from "./format.js";

// A local reload commonly finishes in a few milliseconds. Preserve that exact
// span in the manifest, but pad the presentation on both sides so viewers can
// seek to the transition and understand what happened.
export const RELOAD_CONTEXT_MS = 750;

export function activityTimes(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const interactions = manifest.segments.flatMap((segment) => segmentActivityTimes(eventSets.get(segment.id) ?? [], segment.clock_offset_ms));
  const end = eventEndTime(manifest, eventSets);
  const navigationContext = resolvedNavigationEvents(manifest, eventSets).flatMap((event) => [
    clamp(event.started_at_ms - RELOAD_CONTEXT_MS, 0, end),
    clamp(event.ready_at_ms + RELOAD_CONTEXT_MS, 0, end),
  ]);
  return [...interactions, ...navigationContext];
}
function segmentActivityTimes(events: ReplayEvent[], clockOffsetMs: number) {
  const started = events[0]?.timestamp ?? 0;
  return [clockOffsetMs, ...events.filter(isActivityEvent).map((event) => clockOffsetMs + event.timestamp - started)];
}
export function resolvedNavigationEvents(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>): NavigationEvent[] {
  if (manifest.navigation_events?.length) return manifest.navigation_events;
  // Replays made before first-class navigation capture retain the former
  // meta-event fallback. It is converted once into timeline metadata so the
  // player never reacts to rrweb's seek reconstruction events.
  return manifest.segments.flatMap((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    const firstNavigation = events.find((event) => event.type === EventType.Meta)?.timestamp;
    return events.filter((event) => event.type === EventType.Meta && event.timestamp > (firstNavigation ?? Infinity)).map((event) => {
      const time = segment.clock_offset_ms + event.timestamp - started;
      const href = typeof event.data?.href === "string" ? event.data.href : segment.page_url;
      return { segment_id: segment.id, kind: "reload" as const, started_at_ms: time, committed_at_ms: time, ready_at_ms: time, from_url: href, to_url: href };
    });
  });
}
export function eventEndTime(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  return Math.max(0, ...manifest.segments.map((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    return segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? started) - started);
  }));
}
export function resolveMarkerTimes(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const steps = manifest.segments.flatMap((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    return events.filter((event, index) => isMarkerStep(event, index)).map((event) => segment.clock_offset_ms + event.timestamp - started);
  }).sort((left, right) => left - right);
  const actions = new Map((manifest.actions ?? []).map((action) => [action.id, action]));
  return manifest.markers.map((marker) => {
    // An action-bound marker anchors deterministically on its own action's
    // request/response bracket: the last visible step the action caused, or
    // the action's completion when its effects produced no step of their own.
    const action = marker.action_id ? actions.get(marker.action_id) : undefined;
    if (action) {
      const within = steps.filter((time) => time >= action.started_at_ms && time <= action.finished_at_ms);
      return { ...marker, t_ms: within.at(-1) ?? action.finished_at_ms };
    }
    const related = marker.placement === "before_next"
      ? steps.find((time) => time >= marker.t_ms)
      : [...steps].reverse().find((time) => time <= marker.t_ms);
    return related === undefined ? marker : { ...marker, t_ms: related };
  });
}
export function segmentAtTime(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, time: number) {
  const focused = [...tabEvents(manifest)].reverse().find((event) => event.type === "focused" && event.t_ms <= time && !closedAt(manifest, event.segment_id, time));
  const focusedSegment = manifest.segments.find((segment) => segment.id === focused?.segment_id);
  if (focusedSegment) return focusedSegment;
  return [...manifest.segments].sort((left, right) => right.clock_offset_ms - left.clock_offset_ms).find((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const end = segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? 0) - (events[0]?.timestamp ?? 0));
    return time >= segment.clock_offset_ms && time <= end && !closedAt(manifest, segment.id, time);
  });
}
export function tabEvents(manifest: Manifest) {
  if (manifest.tab_events?.length) return [...manifest.tab_events].sort((left, right) => left.t_ms - right.t_ms);
  return manifest.segments.flatMap((segment) => [
    { type: "opened" as const, segment_id: segment.id, t_ms: segment.clock_offset_ms },
    { type: "focused" as const, segment_id: segment.id, t_ms: segment.clock_offset_ms },
  ]);
}
export function nextFocusForSegment(manifest: Manifest, segmentId: string, after: number) {
  return tabEvents(manifest).find((event) => event.type === "focused" && event.segment_id !== segmentId && event.t_ms > after);
}
export function closedAt(manifest: Manifest, segmentId: string, time: number) {
  return tabEvents(manifest).some((event) => event.type === "closed" && event.segment_id === segmentId && event.t_ms <= time);
}
/** A compact, human-readable rendering of an agent action for marker UI. */
export function describeAction(action: AgentAction) {
  const verb = action.tool.replace(/^browser_/, "").replaceAll("_", " ");
  const detail = action.args_summary ? firstArgumentValue(action.args_summary) : undefined;
  const base = detail ? `${verb} · ${detail}` : verb;
  return action.ok ? base : `${base} (failed)`;
}

/**
 * The first primitive argument is almost always the one a viewer recognizes —
 * a URL, selector, or typed text — so prefer it over raw JSON.
 */
function firstArgumentValue(summary: string) {
  let rendered = summary;
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    const value = Object.values(parsed).find((item) => typeof item === "string" || typeof item === "number");
    if (value !== undefined) rendered = String(value);
  } catch { /* A truncated summary is not valid JSON; show it as captured. */ }
  return rendered.length > 60 ? `${rendered.slice(0, 57)}…` : rendered;
}

export function segmentLabel(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`;
  } catch { return pageUrl; }
}
export function replayViewport(events: ReplayEvent[]) {
  const meta = events.find((event) => event.type === EventType.Meta && event.data?.width && event.data?.height);
  return { width: meta?.data?.width ?? 1280, height: meta?.data?.height ?? 720 };
}
export function sessionEventTime(event: unknown, events: ReplayEvent[], tabStart: number) {
  if (!isReplayEvent(event) || !events[0]) return undefined;
  return tabStart + event.timestamp - events[0].timestamp;
}
function isReplayEvent(event: unknown): event is ReplayEvent {
  return typeof event === "object" && event !== null && "timestamp" in event && typeof (event as { timestamp?: unknown }).timestamp === "number";
}
function isActivityEvent(event: ReplayEvent) {
  // Match rrweb's own user-interaction range: mouse interactions, scrolling,
  // viewport changes, and input count as activity; DOM mutation and narration
  // markers do not keep an idle gap alive.
  const interactionSources: number[] = [IncrementalSource.MouseInteraction, IncrementalSource.Scroll, IncrementalSource.ViewportResize, IncrementalSource.Input];
  return event.type === EventType.IncrementalSnapshot && (interactionSources.includes(event.data?.source ?? -1) || event.data?.replaySynthetic === "approach");
}
function isMarkerStep(event: ReplayEvent, index: number) {
  // Mouse moves describe travel, not an explanation-worthy step. Buttons,
  // input, navigation, and rebuilt documents are visible state transitions.
  if (event.type === EventType.IncrementalSnapshot) return event.data?.source === IncrementalSource.MouseInteraction || event.data?.source === IncrementalSource.Input || event.data?.source === IncrementalSource.Mutation;
  return index > 0 && (event.type === EventType.FullSnapshot || event.type === EventType.Meta);
}
