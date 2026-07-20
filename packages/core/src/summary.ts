import type { ReplayManifest } from "./types.js";

/**
 * A single reviewer-meaningful moment distilled from the raw rrweb stream.
 * Times are raw replay milliseconds (the same clock as manifest markers),
 * not idle-projected player time.
 */
export interface ReplayStep {
  t_ms: number;
  kind: "page" | "navigation" | "click" | "input" | "scroll" | "marker" | "tab" | "idle";
  description: string;
  /** Segment (captured tab) the step happened in, when known. */
  segment_id?: string;
  /** Extra machine-readable context: URLs, typed values, marker notes. */
  detail?: string;
}

export interface ReplaySummary {
  id: string;
  title: string;
  created_at: string;
  outcome?: string;
  notes?: string;
  duration_ms: number;
  tab_count: number;
  urls: string[];
  steps: ReplayStep[];
  idle_total_ms: number;
}

type SerializedNode = {
  type?: number;
  id?: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
};

type RawEvent = {
  timestamp?: number;
  type?: number;
  data?: {
    source?: number;
    type?: number;
    id?: number;
    text?: string;
    isChecked?: boolean;
    href?: string;
    node?: SerializedNode;
    adds?: { node?: SerializedNode }[];
    texts?: { id?: number; value?: string }[];
    attributes?: { id?: number; attributes?: Record<string, unknown> }[];
  };
};

type NodeInfo = { tag: string; attributes: Record<string, string>; text: string };

const IDLE_THRESHOLD_MS = 3_000;
const SCROLL_BURST_MS = 1_500;
const TEXT_LIMIT = 80;

/**
 * Distill a replay into an ordered, human-readable action timeline. This is
 * the model-facing view of a replay: everything speaks raw replay time so
 * answers, markers, and seek targets stay on one clock.
 */
export function summarizeReplay(manifest: ReplayManifest, eventsBySegment: Map<string, unknown[]>): ReplaySummary {
  const steps: ReplayStep[] = [];
  const activity: number[] = [];
  let end = 0;
  for (const segment of manifest.segments) {
    const events = (eventsBySegment.get(segment.id) ?? []) as RawEvent[];
    const started = events.find((event) => typeof event.timestamp === "number")?.timestamp ?? 0;
    const nodes = new Map<number, NodeInfo>();
    const at = (event: RawEvent) => segment.clock_offset_ms + Math.max(0, (event.timestamp ?? started) - started);
    steps.push({ t_ms: segment.clock_offset_ms, kind: "page", segment_id: segment.id, description: `Opened ${segment.page_url}`, detail: segment.page_url });
    let scrollUntil = -Infinity;
    let lastClick: { id: number; time: number; index: number } | undefined;
    for (const event of events) {
      const time = at(event);
      end = Math.max(end, time);
      if (event.type === 2 && event.data?.node) registerTree(nodes, event.data.node);
      if (event.type !== 3 || !event.data) continue;
      const data = event.data;
      if (data.source === 0) {
        for (const add of data.adds ?? []) if (add.node) registerTree(nodes, add.node);
        for (const text of data.texts ?? []) {
          const node = typeof text.id === "number" ? nodes.get(text.id) : undefined;
          if (node && typeof text.value === "string") node.text = clip(text.value);
        }
        for (const change of data.attributes ?? []) {
          const node = typeof change.id === "number" ? nodes.get(change.id) : undefined;
          if (node && change.attributes) Object.assign(node.attributes, stringAttributes(change.attributes));
        }
        continue;
      }
      if (data.source === 2 && (data.type === 2 || data.type === 4)) {
        activity.push(time);
        steps.push({
          t_ms: time,
          kind: "click",
          segment_id: segment.id,
          description: `${data.type === 4 ? "Double-clicked" : "Clicked"} ${describeNode(typeof data.id === "number" ? nodes.get(data.id) : undefined)}`,
        });
        if (typeof data.id === "number") lastClick = { id: data.id, time, index: steps.length - 1 };
        continue;
      }
      if (data.source === 5 && typeof data.text === "string") {
        activity.push(time);
        const node = typeof data.id === "number" ? nodes.get(data.id) : undefined;
        if (isToggleTarget(node, data.text)) {
          // rrweb also reports checkbox state when rows render or update; only
          // a toggle the user just clicked is a step worth narrating. It then
          // replaces the bare click so one action reads as one step.
          if (lastClick && lastClick.id === data.id && time - lastClick.time < 800) {
            steps[lastClick.index] = { t_ms: lastClick.time, kind: "input", segment_id: segment.id, description: `${data.isChecked === false ? "Unchecked" : "Checked"} ${describeNode(node)}` };
            lastClick = undefined;
          }
          continue;
        }
        if (!data.text.trim()) continue;
        const previous = steps.at(-1);
        const step = inputStep(time, segment.id, node, data.text);
        // A keystroke stream arrives as one cumulative input event per key.
        // Keep only the final value per field burst.
        if (previous && previous.kind === "input" && previous.segment_id === segment.id && previous.detail === step.detail && time - previous.t_ms < 10_000) steps[steps.length - 1] = step;
        else steps.push(step);
        continue;
      }
      if (data.source === 3) {
        activity.push(time);
        if (time >= scrollUntil) steps.push({ t_ms: time, kind: "scroll", segment_id: segment.id, description: "Scrolled the page" });
        scrollUntil = time + SCROLL_BURST_MS;
        continue;
      }
      if (data.source === 1 || data.source === 4) activity.push(time);
    }
  }
  for (const navigation of manifest.navigation_events ?? []) {
    activity.push(navigation.started_at_ms, navigation.ready_at_ms);
    end = Math.max(end, navigation.ready_at_ms);
    steps.push({
      t_ms: navigation.started_at_ms,
      kind: "navigation",
      segment_id: navigation.segment_id,
      description: navigation.kind === "reload" ? `Reloaded ${navigation.to_url}` : `Navigated from ${navigation.from_url} to ${navigation.to_url}`,
      detail: navigation.to_url,
    });
  }
  for (const tab of manifest.tab_events ?? []) {
    if (tab.type === "opened") continue; // The segment's own "page" step already covers it.
    const url = manifest.segments.find((segment) => segment.id === tab.segment_id)?.page_url;
    steps.push({ t_ms: tab.t_ms, kind: "tab", segment_id: tab.segment_id, description: tab.type === "focused" ? `Switched to tab ${url ?? tab.segment_id}` : `Closed tab ${url ?? tab.segment_id}` });
  }
  for (const marker of manifest.markers) {
    steps.push({ t_ms: marker.t_ms, kind: "marker", description: `Marker: ${marker.label}`, ...(marker.note ? { detail: marker.note } : {}) });
  }
  const duration = Math.max(end, manifest.raw_duration_ms ?? 0);
  let idleTotal = 0;
  const times = [...new Set([0, ...activity, duration])].sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap < IDLE_THRESHOLD_MS) continue;
    idleTotal += gap;
    steps.push({ t_ms: times[index - 1]!, kind: "idle", description: `Idle for ${(gap / 1000).toFixed(gap >= 10_000 ? 0 : 1)}s, until ${formatTime(times[index]!)} (no user activity)` });
  }
  // Same-instant steps read best in cause-and-effect order: the page exists,
  // then actions on it, then the annotations, then the lull that follows.
  const rank: Record<ReplayStep["kind"], number> = { page: 0, tab: 1, navigation: 2, click: 3, input: 3, scroll: 3, marker: 4, idle: 5 };
  steps.sort((left, right) => left.t_ms - right.t_ms || rank[left.kind] - rank[right.kind]);
  return {
    id: manifest.id,
    title: manifest.title,
    created_at: manifest.created_at,
    ...(manifest.outcome ? { outcome: manifest.outcome } : {}),
    ...(manifest.notes ? { notes: manifest.notes } : {}),
    duration_ms: duration,
    tab_count: manifest.segments.length,
    urls: [...new Set(manifest.segments.map((segment) => segment.page_url))],
    steps,
    idle_total_ms: idleTotal,
  };
}

/** Render the summary as compact prompt-ready text with m:ss timestamps. */
export function renderSummaryText(summary: ReplaySummary, maxSteps = 400): string {
  const lines = [
    `Replay: ${summary.title} (${summary.id})`,
    `Created: ${summary.created_at}${summary.outcome ? ` — outcome: ${summary.outcome}` : ""}`,
    `Duration: ${formatTime(summary.duration_ms)} raw${summary.idle_total_ms >= 1_000 ? ` (${formatTime(summary.idle_total_ms)} idle)` : ""}; ${summary.tab_count} tab${summary.tab_count === 1 ? "" : "s"}`,
    `Pages: ${summary.urls.join(", ")}`,
    ...(summary.notes ? [`Notes: ${summary.notes}`] : []),
    "",
    "Timeline (raw replay time — use these t_ms values with replay tools):",
  ];
  const steps = thinSteps(summary.steps, maxSteps);
  for (const step of steps) {
    lines.push(`- [${formatTime(step.t_ms)}] (t_ms=${Math.round(step.t_ms)}) ${step.description}${step.kind === "marker" && step.detail ? ` — ${step.detail}` : ""}`);
  }
  if (steps.length < summary.steps.length) lines.push(`(… ${summary.steps.length - steps.length} routine steps elided; ask for a time range to see more)`);
  return lines.join("\n");
}

/** Steps within [from_ms, to_ms], for the "zoom into a moment" tool. */
export function stepsInRange(summary: ReplaySummary, fromMs: number, toMs: number): ReplayStep[] {
  return summary.steps.filter((step) => step.t_ms >= fromMs && step.t_ms <= toMs);
}

function thinSteps(steps: ReplayStep[], maxSteps: number): ReplayStep[] {
  if (steps.length <= maxSteps) return steps;
  // Anchors (markers, navigations, tabs, pages, idle) always survive; routine
  // interaction steps are sampled evenly to fit the budget.
  const anchors = new Set<ReplayStep>(steps.filter((step) => !["click", "input", "scroll"].includes(step.kind)));
  const routine = steps.filter((step) => !anchors.has(step));
  const budget = Math.max(0, maxSteps - anchors.size);
  const kept = new Set<ReplayStep>(anchors);
  if (budget > 0) {
    const stride = routine.length / budget;
    for (let index = 0; index < budget; index += 1) kept.add(routine[Math.floor(index * stride)]!);
  }
  return steps.filter((step) => kept.has(step));
}

/** Checkbox and radio state travels as input events; so does the literal value "on" from anonymous toggles. */
function isToggleTarget(node: NodeInfo | undefined, text: string) {
  if (node) {
    const type = String(node.attributes.type ?? "").toLowerCase();
    return node.tag.toLowerCase() === "input" && (type === "checkbox" || type === "radio");
  }
  return text === "on";
}

function inputStep(time: number, segmentId: string, node: NodeInfo | undefined, text: string): ReplayStep {
  const target = describeNode(node);
  const key = `input:${target}`;
  const masked = /^\*+$/.test(text);
  const value = masked ? "(masked)" : `"${clip(text, 48)}"`;
  return { t_ms: time, kind: "input", segment_id: segmentId, description: `Typed ${value} into ${target}`, detail: key };
}

/** Human label for a captured element: its text or accessible name, then tag. */
export function describeNode(node: NodeInfo | undefined): string {
  if (!node) return "an element";
  const attrs = node.attributes;
  const label = attrs["aria-label"] || node.text || attrs.placeholder || attrs.title || attrs.alt || attrs.name || attrs.value;
  const role = nodeRole(node);
  if (label) return `${role} "${clip(String(label), 48)}"`;
  const hint = attrs.id ? `#${attrs.id}` : attrs.class ? `.${String(attrs.class).split(/\s+/)[0]}` : "";
  return hint ? `${role} ${hint}` : `a ${role}`;
}

function nodeRole(node: NodeInfo): string {
  const tag = node.tag.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "dropdown";
  if (tag === "textarea") return "text area";
  if (tag === "input") {
    const type = String(node.attributes.type ?? "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (["checkbox", "radio"].includes(type)) return type;
    return `${type} field`;
  }
  return tag;
}

function registerTree(nodes: Map<number, NodeInfo>, node: SerializedNode) {
  if (typeof node.id === "number" && node.type === 2 && node.tagName) {
    nodes.set(node.id, {
      tag: node.tagName,
      attributes: stringAttributes(node.attributes ?? {}),
      text: clip(directText(node)),
    });
  }
  for (const child of node.childNodes ?? []) registerTree(nodes, child);
}

function directText(node: SerializedNode): string {
  return (node.childNodes ?? [])
    .map((child) => (child.type === 3 ? child.textContent ?? "" : child.type === 2 ? directText(child) : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringAttributes(attributes: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) if (typeof value === "string" || typeof value === "number") output[key] = String(value);
  return output;
}

function clip(value: string, limit = TEXT_LIMIT) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
