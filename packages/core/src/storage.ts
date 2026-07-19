import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentAction, CaptureSummary, Marker, NavigationEvent, RecordedAsset, RecordingManifest, Segment, TabEvent } from "./types.js";

export const recHome = () => process.env.REC_HOME ?? join(process.env.HOME ?? process.cwd(), ".rec");
export const sessionsDir = () => join(recHome(), "sessions");

export function sessionPath(sessionId: string) {
  return join(sessionsDir(), sessionId);
}

export class SessionStore {
  readonly root: string;
  readonly manifest: RecordingManifest;
  private readonly segments = new Map<string, Segment>();
  private readonly assets = new Map<string, RecordedAsset>();
  private sequence = new Map<string, number>();
  private eventTimes: number[] = [];
  private eventCount = 0;
  private manifestWrite: Promise<void> = Promise.resolve();

  private constructor(root: string, manifest: RecordingManifest) {
    this.root = root;
    this.manifest = manifest;
  }

  static async create(manifest: RecordingManifest) {
    const root = sessionPath(manifest.id);
    await mkdir(join(root, "events"), { recursive: true });
    const store = new SessionStore(root, manifest);
    await store.writeManifest();
    return store;
  }

  static async open(sessionId: string) {
    const root = sessionPath(sessionId);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RecordingManifest;
    const store = new SessionStore(root, manifest);
    for (const segment of manifest.segments) {
      store.segments.set(segment.id, segment);
      store.sequence.set(segment.id, segment.chunks.length);
    }
    for (const asset of manifest.assets ?? []) for (const url of asset.source_urls) store.assets.set(url, asset);
    return store;
  }

  segment(id: string, pageUrl: string, clockOffsetMs: number) {
    let segment = this.segments.get(id);
    if (!segment) {
      segment = { id, page_url: pageUrl, clock_offset_ms: clockOffsetMs, chunks: [] };
      this.segments.set(id, segment);
      this.manifest.segments.push(segment);
      this.sequence.set(id, 0);
    }
    return segment;
  }

  async append(segmentId: string, events: unknown[], receivedAtMs: number) {
    if (events.length === 0) return;
    const segment = this.segments.get(segmentId);
    if (!segment) throw new Error(`Unknown segment ${segmentId}`);
    const seq = this.sequence.get(segmentId) ?? 0;
    const relative = `events/${segmentId}-${String(seq).padStart(4, "0")}.jsonl.gz`;
    const content = events.map((event) => JSON.stringify({ segment_id: segmentId, received_at_ms: receivedAtMs, event })).join("\n") + "\n";
    const target = join(this.root, relative);
    await pipeline(Readable.from([content]), createGzip(), createWriteStream(target, { flags: "wx" }));
    segment.chunks.push(relative);
    this.sequence.set(segmentId, seq + 1);
    this.eventCount += events.length;
    for (const event of events) {
      const timestamp = typeof event === "object" && event !== null && "timestamp" in event
        ? Number((event as { timestamp: unknown }).timestamp)
        : NaN;
      if (Number.isFinite(timestamp)) this.eventTimes.push(timestamp);
    }
    await this.writeManifest();
  }

  /** Stores a static resource once and maps every observed source URL to it. */
  async addAsset(sourceUrl: string, body: Uint8Array, contentType: string) {
    const existing = this.assets.get(sourceUrl);
    if (existing) return existing;
    const id = createHash("sha256").update(body).digest("hex");
    const matching = this.manifest.assets.find((asset) => asset.id === id);
    if (matching) {
      matching.source_urls.push(sourceUrl);
      this.assets.set(sourceUrl, matching);
      await this.writeManifest();
      return matching;
    }
    const asset: RecordedAsset = {
      id,
      source_urls: [sourceUrl],
      path: `assets/${id}`,
      content_type: sanitizeContentType(contentType),
      bytes: body.byteLength,
    };
    await mkdir(join(this.root, "assets"), { recursive: true });
    await writeFile(join(this.root, asset.path), body, { flag: "wx" });
    this.manifest.assets.push(asset);
    this.assets.set(sourceUrl, asset);
    await this.writeManifest();
    return asset;
  }

  addMarker(marker: Marker) {
    this.manifest.markers.push(marker);
  }

  addAction(action: AgentAction) {
    const actions = this.manifest.actions ?? (this.manifest.actions = []);
    actions.push(action);
  }

  captureSummary(): CaptureSummary {
    return {
      segmentCount: this.manifest.segments.length,
      chunkCount: this.manifest.segments.reduce((count, segment) => count + segment.chunks.length, 0),
      eventCount: this.eventCount,
    };
  }

  addTabEvent(event: TabEvent) {
    const tabEvents = this.manifest.tab_events ?? (this.manifest.tab_events = []);
    const previous = tabEvents.at(-1);
    // visibilitychange can fire twice while a popup is settling. Preserve the
    // meaningful lifecycle edge, not duplicate focus noise.
    if (previous?.type === event.type && previous.segment_id === event.segment_id && event.t_ms - previous.t_ms < 100) return;
    tabEvents.push(event);
  }

  addNavigationEvent(event: NavigationEvent) {
    const transitions = this.manifest.navigation_events ?? (this.manifest.navigation_events = []);
    // A redirect can surface more than one lifecycle callback for the same
    // committed document. Keep the first durable transition instead of making
    // the player render duplicate refresh cards.
    if (transitions.some((item) => item.segment_id === event.segment_id && Math.abs(item.committed_at_ms - event.committed_at_ms) < 100)) return;
    transitions.push(event);
  }

  async finalize(outcome?: RecordingManifest["outcome"], notes?: string) {
    const started = Date.parse(this.manifest.created_at);
    const stopped = Date.now();
    this.manifest.stopped_at = new Date(stopped).toISOString();
    this.manifest.outcome = outcome;
    this.manifest.notes = notes;
    this.manifest.raw_duration_ms = Math.max(0, stopped - started);
    this.manifest.active_duration_ms = calculateActiveDuration(this.eventTimes);
    await writeFile(join(this.root, "markers.json"), JSON.stringify(this.manifest.markers, null, 2) + "\n");
    await this.writeManifest();
  }

  private async writeManifest() {
    // Event batches can arrive from several pages at once. Serialize the
    // replace operation so two writers never contend for manifest.json.tmp.
    const write = async () => {
      const target = join(this.root, "manifest.json");
      const temporary = `${target}.tmp`;
      await writeFile(temporary, JSON.stringify(this.manifest, null, 2) + "\n");
      await rename(temporary, target);
    };
    this.manifestWrite = this.manifestWrite.then(write, write);
    return this.manifestWrite;
  }
}

function sanitizeContentType(value: string) {
  return value.split(";", 1)[0]?.trim() || "application/octet-stream";
}

export function calculateActiveDuration(eventTimes: number[], idleGapMs = 3_000) {
  const times = [...new Set(eventTimes.filter(Number.isFinite))].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  let active = 0;
  for (let index = 1; index < times.length; index += 1) {
    active += Math.min(Math.max(0, times[index] - times[index - 1]), idleGapMs);
  }
  return active;
}
