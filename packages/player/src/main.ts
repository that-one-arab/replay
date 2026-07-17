import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";

type Marker = { t_ms: number; label: string; note?: string };
type Manifest = { id: string; title: string; markers: Marker[]; segments: { id: string }[] };
type ReplayEvent = { timestamp: number; type: number; data?: { source?: number } };

const app = document.querySelector<HTMLDivElement>("#app")!;
const id = new URLSearchParams(location.search).get("id");
if (!id) renderError("Choose a recording with `rec open <id>`.");
else void load(id);

async function load(recordingId: string) {
  try {
    const manifest = await request<Manifest>(`/api/sessions/${encodeURIComponent(recordingId)}/manifest`);
    renderShell(manifest);
    await replay(manifest, manifest.segments[0]?.id);
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest) {
  app.innerHTML = `<main class="replay-screen" aria-label="${escape(manifest.title)}"><div id="replay" aria-label="Session replay"></div><div class="video-shade"></div><div class="playback-state"><span></span><b id="stage-status">Paused</b></div><div class="caption-card" id="caption"><span class="caption-kicker">REPLAY NOTE</span><strong>Press play to begin</strong><p>Key steps and interactions will be highlighted here.</p></div><section class="control-deck" aria-label="Replay controls"><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div><div class="speed-control" role="group" aria-label="Playback speed"><button data-speed="1" class="selected">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button><button data-speed="8">8×</button></div><button class="skip-button active" id="skip"><span>↯</span> Skip idle</button></div><div class="timeline-wrap"><div class="timeline-density" id="density"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Replay timeline" /></div></section></main>`;
}

async function replay(manifest: Manifest, segmentId: string | undefined) {
  if (!segmentId) return;
  const events = await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segmentId)}`);
  if (events.length < 2) throw new Error("This segment does not have enough events to replay.");
  const mount = document.querySelector<HTMLDivElement>("#replay")!;
  mount.replaceChildren();
  const duration = Math.max(1, events.at(-1)!.timestamp - events[0].timestamp);
  prepareTimeline(manifest, duration, events.filter(isInteraction).map((event) => event.timestamp - events[0].timestamp));
  const replayer = new Replayer(events as never[], {
    root: mount, skipInactive: true, showWarning: false,
    mouseTail: { duration: 420, lineWidth: 2, strokeStyle: "rgba(106, 87, 255, .45)" },
    insertStyleRules: [".rec-focus-target{outline:3px solid #6956ff!important;outline-offset:3px!important;box-shadow:0 0 0 7px rgba(105,86,255,.18)!important;border-radius:4px!important}"]
  });
  let playing = false;
  let scrubbing = false;
  const scrubber = document.querySelector<HTMLInputElement>("#scrubber")!;
  scrubber.max = String(duration);
  document.querySelector<HTMLElement>("#total-time")!.textContent = format(duration);
  const setPlaying = (value: boolean) => {
    playing = value;
    document.querySelector<HTMLButtonElement>("#play")!.classList.toggle("is-playing", value);
    document.querySelector<HTMLElement>("#stage-status")!.textContent = value ? "Playing" : "Paused";
  };
  const updateProgress = () => {
    if (!scrubbing) {
      const time = clamp(replayer.getCurrentTime(), 0, duration);
      scrubber.value = String(time);
      document.querySelector<HTMLElement>("#current-time")!.textContent = format(time);
      syncNarration(manifest, time);
    }
    if (playing) requestAnimationFrame(updateProgress);
  };
  replayer.on("start", () => { setPlaying(true); requestAnimationFrame(updateProgress); });
  replayer.on("resume", () => { setPlaying(true); requestAnimationFrame(updateProgress); });
  replayer.on("pause", () => setPlaying(false));
  replayer.on("finish", () => { setPlaying(false); scrubber.value = String(duration); });
  replayer.on("mouse-interaction", (payload: unknown) => {
    const target = (payload as { target?: unknown }).target;
    if (!isElementLike(target)) return;
    target.classList.remove("rec-focus-target");
    target.classList.add("rec-focus-target");
    window.setTimeout(() => target.classList.remove("rec-focus-target"), 900);
    setActionCaption(`Clicked ${readableTarget(target)}`, "The selected control is highlighted in the replay.");
  });
  document.querySelector<HTMLButtonElement>("#play")!.onclick = () => playing ? replayer.pause() : replayer.play(Number(scrubber.value));
  document.querySelector<HTMLButtonElement>("#skip")!.onclick = () => {
    replayer.setConfig({ skipInactive: !replayer.config.skipInactive });
    document.querySelector<HTMLButtonElement>("#skip")!.classList.toggle("active", replayer.config.skipInactive);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((button) => button.onclick = () => {
    document.querySelector(".speed-control .selected")?.classList.remove("selected");
    button.classList.add("selected");
    replayer.setConfig({ speed: Number(button.dataset.speed) });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marker]").forEach((button) => button.onclick = () => replayer.play(Number(button.dataset.marker)));
  scrubber.addEventListener("pointerdown", () => { scrubbing = true; });
  scrubber.addEventListener("input", () => {
    const time = Number(scrubber.value);
    document.querySelector<HTMLElement>("#current-time")!.textContent = format(time);
    syncNarration(manifest, time);
  });
  scrubber.addEventListener("change", () => { scrubbing = false; playing ? replayer.play(Number(scrubber.value)) : replayer.pause(Number(scrubber.value)); });
  syncNarration(manifest, 0);
  const openingFrame = Math.max(0, (events.find((event) => event.type === 2)?.timestamp ?? events[0].timestamp) - events[0].timestamp);
  replayer.pause(openingFrame);
}

function prepareTimeline(manifest: Manifest, duration: number, interactions: number[]) {
  const density = document.querySelector<HTMLElement>("#density")!;
  const buckets = Array.from({ length: 72 }, () => 0);
  interactions.forEach((time) => { buckets[Math.min(buckets.length - 1, Math.floor(time / duration * buckets.length))] += 1; });
  const max = Math.max(1, ...buckets);
  density.innerHTML = buckets.map((count) => `<i style="--level:${Math.max(.08, count / max)}"></i>`).join("");
  document.querySelector<HTMLElement>("#timeline-markers")!.innerHTML = manifest.markers.map((marker) => `<button data-marker="${marker.t_ms}" title="${escape(marker.label)}" style="left:${clamp(marker.t_ms / duration * 100, 1, 99)}%"><span></span></button>`).join("");
}

function syncNarration(manifest: Manifest, time: number) {
  const marker = [...manifest.markers].reverse().find((item) => item.t_ms <= time + 450);
  if (marker) setActionCaption(marker.label, marker.note ?? "Narrated journey checkpoint");
}
function setActionCaption(title: string, copy: string) { document.querySelector<HTMLElement>("#caption strong")!.textContent = title; document.querySelector<HTMLElement>("#caption p")!.textContent = copy; }
function isInteraction(event: ReplayEvent) { return event.type === 3 && event.data?.source === 2; }
type ElementLike = { nodeType: number; classList: DOMTokenList; getAttribute(name: string): string | null; textContent: string | null; tagName: string };
function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }
function readableTarget(target: ElementLike) { const text = target.getAttribute("aria-label") || target.textContent?.trim() || target.tagName.toLowerCase(); return `“${text.replace(/\s+/g, " ").slice(0, 64)}”`; }
async function request<T>(url: string) { const response = await fetch(url); if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error); return response.json() as Promise<T>; }
function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
