export type Outcome = "reproduced" | "verified" | "other";

export interface Marker {
  t_ms: number;
  label: string;
  note?: string;
  /**
   * Narrative placement relative to the agent's ordered browser actions.
   * Only meaningful for standalone markers; action-bound markers carry
   * `action_id` instead and are anchored on the action's own bracket.
   */
  placement?: "after_previous" | "before_next";
  /** Optional visual emphasis. A yellow or green marker stands out from the default checkpoints. */
  color?: "yellow" | "green";
  /** The agent action this marker was captured atomically with, when it was. */
  action_id?: string;
}

/** One embedded browser tool call the agent issued while capturing. */
export interface AgentAction {
  id: string;
  tool: string;
  /** Compact single-line rendering of the tool arguments. */
  args_summary?: string;
  started_at_ms: number;
  finished_at_ms: number;
  ok: boolean;
}

export interface ActionInput {
  id: string;
  tool: string;
  argsSummary?: string;
  startedAtEpochMs: number;
  finishedAtEpochMs: number;
  ok: boolean;
  marker?: { label: string; note?: string; color?: Marker["color"] };
}

export interface Segment {
  id: string;
  page_url: string;
  clock_offset_ms: number;
  chunks: string[];
}

/** A static visual resource copied into the session bundle for replay. */
export interface CapturedAsset {
  id: string;
  source_urls: string[];
  path: string;
  content_type: string;
  bytes: number;
}

export interface TabEvent {
  t_ms: number;
  segment_id: string;
  type: "opened" | "focused" | "closed";
}

/** A top-level document transition observed by Replay while capturing. */
export interface NavigationEvent {
  segment_id: string;
  kind: "reload" | "navigate";
  started_at_ms: number;
  committed_at_ms: number;
  ready_at_ms: number;
  from_url: string;
  to_url: string;
}

export interface ReplayManifest {
  format_version: 1;
  id: string;
  title: string;
  outcome?: Outcome;
  notes?: string;
  created_at: string;
  stopped_at?: string;
  capture: { version: string; rrweb: string; capture_canvas: boolean; capture_cross_origin_iframes: boolean };
  origins: string[];
  masking: { mask_all_inputs: boolean; passwords: true };
  /** Author defaults for player-only pacing; absent on replays made before configuration support. */
  replay_defaults?: {
    idle_mode: "cut" | "fast_forward" | "preserve";
    idle_retained_ms: number;
    idle_fast_forward_speed: number;
    default_speed: number;
  };
  raw_duration_ms?: number;
  active_duration_ms?: number;
  segments: Segment[];
  tab_events: TabEvent[];
  /** Optional for compatibility with replays created before navigation capture. */
  navigation_events?: NavigationEvent[];
  markers: Marker[];
  /** Optional for compatibility with replays created before action capture. */
  actions?: AgentAction[];
  assets: CapturedAsset[];
}

export interface StartOptions {
  title?: string;
  origins?: string[];
  maskAllInputs?: boolean;
  /** Opt-in because canvas pixels can add sensitive visual data and bundle size. */
  captureCanvas?: boolean;
  /** Resolved by Replay's daemon, not normally passed by a coding agent. */
  replayDefaults?: ReplayManifest["replay_defaults"];
}

export interface StopResult {
  sessionId: string;
  path: string;
  rawDurationMs: number;
  activeDurationMs: number;
  markers: Marker[];
  capture: CaptureSummary;
}

export interface CaptureSummary {
  segmentCount: number;
  chunkCount: number;
  eventCount: number;
}

export interface BrowserStatus {
  attached: boolean;
  pageCount: number;
  navigatedPageCount: number;
}
