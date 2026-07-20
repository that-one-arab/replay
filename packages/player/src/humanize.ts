/**
 * Grooming for raw rrweb event streams before replay: reconstruct human
 * pointer travel from instantaneous driver jumps, pace typing onto a
 * keystroke cadence, and cue the synthetic cursor ahead of interactions in
 * replays that carry no pointer coordinates.
 */
import { EventType, IncrementalSource, MouseInteraction, type ReplayEvent } from "./types.js";

export const CURSOR_APPROACH_MS = 420;
// Beat the synthetic cursor rests on its target after arriving, before the
// action fires — enough room to read "it's here, about to act."
export const CURSOR_DWELL_MS = 320;
export const KEYSTROKE_PACE_MS = 85;

export function humanizeEvents(events: ReplayEvent[]) {
  const output: ReplayEvent[] = [];
  let addedDelay = 0;
  let lastEmittedAt = -Infinity;
  let cursor: { x: number; y: number; t: number } | undefined;
  // rrweb stores an input's full cumulative value on every keystroke. Remember
  // the last value per field so a stream of per-keystroke events can be paced
  // in place instead of re-dramatized from the first character.
  const lastInput = new Map<number, { text: string; nextSlot: number }>();
  for (const event of events) {
    // Playwright's raw move stream often represents instantaneous driver jumps,
    // not a useful human gesture. Reconstruct that gesture from actual targets.
    if (event.type === EventType.IncrementalSnapshot && event.data?.source === IncrementalSource.MouseMove) continue;
    const adjusted = { ...event, timestamp: event.timestamp + addedDelay, data: event.data ? { ...event.data } : undefined };
    const pointer = pointerPosition(adjusted);
    // The first pointer position has no visible origin to travel from — the
    // cursor fades in on target instead of flying in from the page corner.
    if (isDirectPointerInteraction(adjusted) && pointer && cursor && adjusted.timestamp - cursor.t >= 280) {
      const approachAt = Math.max(lastEmittedAt + 1, adjusted.timestamp - CURSOR_APPROACH_MS);
      if (approachAt < adjusted.timestamp - 45) {
        // A single endpoint still lets rrweb paint the cursor directly on the
        // target. Give it a short, timed path instead, continuing from the
        // prior target.
        const origin = cursor;
        const steps = 8;
        const positions = Array.from({ length: steps }, (_, index) => {
          const progress = index / (steps - 1);
          const eased = progress < 0.5
            ? 4 * progress ** 3
            : 1 - (-2 * progress + 2) ** 3 / 2;
          return {
            x: origin.x + (pointer.x - origin.x) * eased,
            y: origin.y + (pointer.y - origin.y) * eased,
            id: pointer.id,
            timeOffset: Math.round(progress * CURSOR_APPROACH_MS),
          };
        });
        output.push({ type: EventType.IncrementalSnapshot, timestamp: approachAt, data: { source: IncrementalSource.MouseMove, replaySynthetic: "approach", positions } });
        lastEmittedAt = approachAt;
        cursor = { ...pointer, t: adjusted.timestamp };
      }
    }
    const typedText = typeableFill(adjusted);
    if (typedText !== undefined) {
      const id = adjusted.data!.id;
      const prior = typeof id === "number" ? lastInput.get(id) : undefined;
      // Incremental typing: this event is the previous value plus one or more
      // characters. rrweb already has the right cumulative value, so just pace
      // it onto the keystroke cadence. Splitting from the first character here
      // is what visibly deletes and retypes the field on every keystroke.
      const added = prior && typedText.startsWith(prior.text) ? Array.from(typedText).length - Array.from(prior.text).length : 0;
      if (prior && added > 0) {
        const stepAt = Math.max(adjusted.timestamp, prior.nextSlot);
        addedDelay += Math.max(0, stepAt - adjusted.timestamp);
        output.push({ ...adjusted, timestamp: stepAt });
        lastEmittedAt = stepAt;
        prior.text = typedText;
        prior.nextSlot = stepAt + added * KEYSTROKE_PACE_MS;
        continue;
      }
      if (isVisibleShortFill(adjusted)) {
        // A batch fill (paste or a single insertText) arrives with the whole
        // value at once; dramatize it character by character from an empty field.
        const characters = Array.from(typedText);
        let slot = adjusted.timestamp;
        for (let index = 0; index < characters.length; index += 1) {
          const typed = characters.slice(0, index + 1).join("");
          slot = adjusted.timestamp + (index + 1) * KEYSTROKE_PACE_MS;
          output.push({ ...adjusted, timestamp: slot, data: { ...adjusted.data, text: typed } });
        }
        addedDelay += characters.length * KEYSTROKE_PACE_MS;
        lastEmittedAt = slot;
        if (typeof id === "number") lastInput.set(id, { text: typedText, nextSlot: slot + KEYSTROKE_PACE_MS });
        continue;
      }
      // Lone keystrokes (one or two characters) and checkbox "on" values pass
      // through unchanged, but the value is still remembered so the next
      // keystroke is recognized as incremental.
      output.push(adjusted);
      lastEmittedAt = adjusted.timestamp;
      if (typeof id === "number") lastInput.set(id, { text: typedText, nextSlot: adjusted.timestamp + KEYSTROKE_PACE_MS });
      continue;
    }
    output.push(adjusted);
    lastEmittedAt = adjusted.timestamp;
    if (pointer) cursor = { ...pointer, t: adjusted.timestamp };
  }
  return output;
}

/**
 * Insert a lead-in cue before every click/double-click/focus so the synthetic
 * cursor starts travelling ahead of the action. Works on already-projected
 * (playback-time) events, so the lead is real screen time — a raw-time lead
 * would collapse inside a cut idle gap right before the interaction.
 */
export function withCursorLeadIns(events: ReplayEvent[]): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  const cuedInteractions: number[] = [MouseInteraction.Click, MouseInteraction.DblClick, MouseInteraction.Focus];
  let lastTs = -Infinity;
  for (const event of events) {
    if (event.type === EventType.IncrementalSnapshot && event.data?.source === IncrementalSource.MouseInteraction && cuedInteractions.includes(event.data.type ?? -1) && typeof event.data.id === "number") {
      // Lead by the glide plus a dwell beat, so the cursor arrives early and
      // rests on the target before the action fires.
      const at = Math.max(lastTs + 1, event.timestamp - CURSOR_APPROACH_MS - CURSOR_DWELL_MS);
      if (at < event.timestamp - 40) {
        out.push({ type: EventType.Custom, timestamp: at, data: { tag: "replay-cursor", id: event.data.id } });
        lastTs = at;
      }
    }
    out.push(event);
    lastTs = event.timestamp;
  }
  return out;
}

// Agent-driven clicks are often captured at the page origin (0,0) because the
// driver dispatches them without pointer coordinates. Treat that as "no real
// position" so the cursor is never parked, revealed, or zoomed at the top-left.
export function isRealPoint(x: number | undefined, y: number | undefined) {
  return Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0);
}
export function pointerPosition(event: ReplayEvent) {
  if (event.type !== EventType.IncrementalSnapshot) return undefined;
  if (event.data?.source === IncrementalSource.MouseMove) return event.data.positions?.at(-1);
  if (event.data?.source === IncrementalSource.MouseInteraction && isRealPoint(event.data.x, event.data.y)) return { x: event.data.x!, y: event.data.y!, id: event.data.id };
  return undefined;
}
function isDirectPointerInteraction(event: ReplayEvent) {
  return event.type === EventType.IncrementalSnapshot && event.data?.source === IncrementalSource.MouseInteraction && isRealPoint(event.data.x, event.data.y);
}
function typeableFill(event: ReplayEvent): string | undefined {
  if (event.type !== EventType.IncrementalSnapshot || event.data?.source !== IncrementalSource.Input) return undefined;
  const text = event.data?.text;
  return typeof text === "string" ? text : undefined;
}
function isVisibleShortFill(event: ReplayEvent) {
  const text = event.data?.text;
  return event.type === EventType.IncrementalSnapshot && event.data?.source === IncrementalSource.Input && typeof text === "string" && text.length > 2 && text.length <= 32 && text !== "on";
}
