export type Outcome = "reproduced" | "verified" | "other";

export interface Marker {
  t_ms: number;
  label: string;
  note?: string;
}

export interface Segment {
  id: string;
  page_url: string;
  clock_offset_ms: number;
  chunks: string[];
}

export interface RecordingManifest {
  format_version: 1;
  id: string;
  title: string;
  outcome?: Outcome;
  notes?: string;
  created_at: string;
  stopped_at?: string;
  recorder: { version: string; rrweb: string };
  origins: string[];
  masking: { mask_all_inputs: boolean; passwords: true };
  raw_duration_ms?: number;
  active_duration_ms?: number;
  segments: Segment[];
  markers: Marker[];
}

export interface StartOptions {
  title?: string;
  origins?: string[];
  maskAllInputs?: boolean;
}

export interface StopResult {
  sessionId: string;
  path: string;
  rawDurationMs: number;
  activeDurationMs: number;
  markers: Marker[];
}
