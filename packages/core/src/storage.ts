import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Marker, RecordingManifest, Segment } from "./types.js";

export const recHome = () => process.env.REC_HOME ?? join(process.env.HOME ?? process.cwd(), ".rec");
export const sessionsDir = () => join(recHome(), "sessions");

export function sessionPath(sessionId: string) {
  return join(sessionsDir(), sessionId);
}

export class SessionStore {
  readonly root: string;
  readonly manifest: RecordingManifest;
  private readonly segments = new Map<string, Segment>();
  private sequence = new Map<string, number>();
  private eventTimes: number[] = [];
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
    for (const event of events) {
      const timestamp = typeof event === "object" && event !== null && "timestamp" in event
        ? Number((event as { timestamp: unknown }).timestamp)
        : NaN;
      if (Number.isFinite(timestamp)) this.eventTimes.push(timestamp);
    }
    await this.writeManifest();
  }

  addMarker(marker: Marker) {
    this.manifest.markers.push(marker);
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

export function calculateActiveDuration(eventTimes: number[], idleGapMs = 3_000) {
  const times = [...new Set(eventTimes.filter(Number.isFinite))].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  let active = 0;
  for (let index = 1; index < times.length; index += 1) {
    active += Math.min(Math.max(0, times[index] - times[index - 1]), idleGapMs);
  }
  return active;
}
