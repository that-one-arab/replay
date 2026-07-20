/**
 * Shared player domain types: the manifest the daemon serves, the rrweb event
 * envelope the player consumes, and the playback projection derived from them.
 */

export type Defect = { expected: string; actual: string };
export type Hold = "beat" | "until_ack" | "none";
export type Marker = { t_ms: number; label: string; note?: string; placement?: "after_previous" | "before_next"; color?: "yellow" | "green"; action_id?: string; node_id?: number; defect?: Defect; hold?: Hold };
export type AgentAction = { id: string; tool: string; args_summary?: string; started_at_ms: number; finished_at_ms: number; ok: boolean };
export type Segment = { id: string; page_url: string; clock_offset_ms: number };
export type TabEvent = { t_ms: number; segment_id: string; type: "opened" | "focused" | "closed" };
export type NavigationEvent = { segment_id: string; kind: "reload" | "navigate"; started_at_ms: number; committed_at_ms: number; ready_at_ms: number; from_url: string; to_url: string };
export type IdleMode = "cut" | "fast_forward" | "preserve";
export type ReplayDefaults = { idle_mode: IdleMode; idle_retained_ms: number; idle_fast_forward_speed: number; default_speed: number };
export type Manifest = { id: string; title: string; created_at?: string; outcome?: string; notes?: string; markers: Marker[]; actions?: AgentAction[]; segments: Segment[]; tab_events?: TabEvent[]; navigation_events?: NavigationEvent[]; raw_duration_ms?: number; replay_defaults?: ReplayDefaults };
export type ReplayEvent = { timestamp: number; type: number; data?: { source?: number; type?: number; href?: string; width?: number; height?: number; text?: string; id?: number; x?: number; y?: number; replaySynthetic?: "approach"; tag?: string; positions?: { x: number; y: number; id?: number; timeOffset?: number }[] } };
export type IdleRange = { start: number; end: number };
export type TimelineIdleRange = IdleRange & { originalDuration: number; mode: IdleMode; speed: number };
export type PlaybackProjection = { manifest: Manifest; eventSets: Map<string, ReplayEvent[]>; duration: number; activities: number[]; playbackEnd: number; idleRanges: TimelineIdleRange[]; toPlayback(time: number): number; toRaw(time: number): number };

// rrweb's wire-format discriminants, named so event handling reads as intent
// instead of numerology. Values mirror rrweb's EventType, IncrementalSource,
// and MouseInteractions enums — only the members the player relies on.
export const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4, Custom: 5 } as const;
export const IncrementalSource = { Mutation: 0, MouseMove: 1, MouseInteraction: 2, Scroll: 3, ViewportResize: 4, Input: 5 } as const;
export const MouseInteraction = { Click: 2, DblClick: 4, Focus: 5 } as const;
