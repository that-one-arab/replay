export type Outcome = "reproduced" | "verified" | "other";

export interface Marker {
  t_ms: number;
  label: string;
  note?: string;
  /**
   * Narrative placement relative to the agent's ordered browser actions.
   * It is deliberately not a cross-server Playwright action identifier.
   */
  placement?: "after_previous" | "before_next";
}

export interface Segment {
  id: string;
  page_url: string;
  clock_offset_ms: number;
  chunks: string[];
}

/** A static visual resource copied into the session bundle for replay. */
export interface RecordedAsset {
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

/** A top-level document transition observed by Rec while recording. */
export interface NavigationEvent {
  segment_id: string;
  kind: "reload" | "navigate";
  started_at_ms: number;
  committed_at_ms: number;
  ready_at_ms: number;
  from_url: string;
  to_url: string;
}

export interface RecordingManifest {
  format_version: 1;
  id: string;
  title: string;
  outcome?: Outcome;
  notes?: string;
  created_at: string;
  stopped_at?: string;
  recorder: { version: string; rrweb: string; record_canvas: boolean; record_cross_origin_iframes: boolean };
  origins: string[];
  masking: { mask_all_inputs: boolean; passwords: true };
  raw_duration_ms?: number;
  active_duration_ms?: number;
  segments: Segment[];
  tab_events: TabEvent[];
  /** Optional for compatibility with recordings created before navigation capture. */
  navigation_events?: NavigationEvent[];
  markers: Marker[];
  assets: RecordedAsset[];
}

export interface StartOptions {
  title?: string;
  origins?: string[];
  maskAllInputs?: boolean;
  /** Opt-in because canvas pixels can add sensitive visual data and bundle size. */
  recordCanvas?: boolean;
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
