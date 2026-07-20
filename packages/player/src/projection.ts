/**
 * The playback projection: detect idle gaps in raw replay time, collapse
 * or compress them per the selected idle mode, and remap the manifest, event
 * sets, and timeline metadata onto the projected playback clock.
 */
import type { IdleMode, IdleRange, Manifest, PlaybackProjection, ReplayDefaults, ReplayEvent } from "./types.js";
import { activityTimes, eventEndTime, resolvedNavigationEvents } from "./manifest.js";

// Keep the default pace in one place so product teams can tune it without
// changing the replay control behavior.
export const DEFAULT_PLAYBACK_SPEED = 1.15;
export const DEFAULT_REPLAY_DEFAULTS: ReplayDefaults = { idle_mode: "cut", idle_retained_ms: 2_000, idle_fast_forward_speed: 8, default_speed: DEFAULT_PLAYBACK_SPEED };
export const IDLE_THRESHOLD_MS = 3_000;

export function projectPlayback(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, idleMode: IdleMode, defaults: ReplayDefaults): PlaybackProjection {
  const playbackEnd = eventEndTime(manifest, eventSets);
  const activities = activityTimes(manifest, eventSets);
  const navigationEvents = resolvedNavigationEvents(manifest, eventSets);
  const rawIdle = idleRanges(activities, playbackEnd);
  const scale = (range: IdleRange) => idleScale(range, idleMode, defaults);
  // The session clock (t=0) starts at recorder init, but the first rrweb
  // snapshot arrives only after the capture wiring settles — a dead pre-roll
  // with no events before the earliest segment. Drop it so the timeline's 0
  // lands on the first real content; otherwise those opening seconds are
  // unreachable and every seek into them clamps forward to the first frame.
  const lead = manifest.segments.length
    ? manifest.segments.reduce((min, segment) => Math.min(min, segment.clock_offset_ms), Infinity)
    : 0;
  const idleToPlayback = (time: number) => {
    let removed = 0;
    for (const range of rawIdle) {
      const projectedDuration = (range.end - range.start) * scale(range);
      if (time >= range.end) { removed += range.end - range.start - projectedDuration; continue; }
      if (time > range.start) return range.start - removed + (time - range.start) * scale(range);
      break;
    }
    return time - removed;
  };
  const idleToRaw = (time: number) => {
    let removed = 0;
    for (const range of rawIdle) {
      const projectedDuration = (range.end - range.start) * scale(range);
      const compactStart = range.start - removed;
      const compactEnd = compactStart + projectedDuration;
      if (time >= compactEnd) { removed += range.end - range.start - projectedDuration; continue; }
      if (time > compactStart) return range.start + (time - compactStart) / scale(range);
      break;
    }
    return time + removed;
  };
  const toPlayback = (time: number) => idleToPlayback(time) - lead;
  const toRaw = (time: number) => idleToRaw(time + lead);
  const projectedManifest: Manifest = {
    ...manifest,
    raw_duration_ms: toPlayback(playbackEnd),
    segments: manifest.segments.map((segment) => ({ ...segment, clock_offset_ms: toPlayback(segment.clock_offset_ms) })),
    tab_events: manifest.tab_events?.map((event) => ({ ...event, t_ms: toPlayback(event.t_ms) })),
    navigation_events: navigationEvents.map((event) => ({
      ...event,
      started_at_ms: toPlayback(event.started_at_ms),
      committed_at_ms: toPlayback(event.committed_at_ms),
      ready_at_ms: toPlayback(event.ready_at_ms),
    })),
    markers: manifest.markers.map((marker) => ({ ...marker, t_ms: toPlayback(marker.t_ms) })),
  };
  const projectedEvents = new Map(projectedManifest.segments.map((segment) => {
    const source = eventSets.get(segment.id) ?? [];
    const originalSegment = manifest.segments.find((item) => item.id === segment.id)!;
    const started = source[0]?.timestamp ?? 0;
    const events = source.map((event) => ({ ...event, timestamp: started + toPlayback(originalSegment.clock_offset_ms + event.timestamp - started) - segment.clock_offset_ms }));
    return [segment.id, events] as const;
  }));
  const projectedIdle = rawIdle.map((range) => ({ start: toPlayback(range.start), end: toPlayback(range.end), originalDuration: range.end - range.start, mode: idleMode, speed: defaults.idle_fast_forward_speed }));
  return {
    manifest: projectedManifest,
    eventSets: projectedEvents,
    duration: toPlayback(playbackEnd),
    activities: activities.map(toPlayback),
    playbackEnd: toPlayback(playbackEnd),
    idleRanges: projectedIdle,
    toPlayback,
    toRaw,
  };
}

function idleScale(range: IdleRange, mode: IdleMode, defaults: ReplayDefaults) {
  const duration = range.end - range.start;
  if (mode === "preserve") return 1;
  if (mode === "fast_forward") return 1 / defaults.idle_fast_forward_speed;
  return Math.min(1, defaults.idle_retained_ms / duration);
}

export function resolvedReplayDefaults(value: ReplayDefaults | undefined): ReplayDefaults {
  if (!value || !["cut", "fast_forward", "preserve"].includes(value.idle_mode)) return DEFAULT_REPLAY_DEFAULTS;
  if (![value.idle_retained_ms, value.idle_fast_forward_speed, value.default_speed].every((item) => Number.isFinite(item) && item > 0)) return DEFAULT_REPLAY_DEFAULTS;
  return value;
}

export function idleRanges(activities: number[], playbackEnd: number): IdleRange[] {
  const times = [...new Set(activities.filter((time) => time >= 0 && time <= playbackEnd).sort((left, right) => left - right))];
  const ranges: IdleRange[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const start = times[index - 1]!;
    const end = times[index]!;
    if (end - start >= IDLE_THRESHOLD_MS) ranges.push({ start, end });
  }
  const last = times.at(-1);
  if (last !== undefined && playbackEnd - last >= IDLE_THRESHOLD_MS) ranges.push({ start: last, end: playbackEnd });
  return ranges;
}
