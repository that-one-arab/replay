import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";

type Marker = { t_ms: number; label: string; note?: string };
type Segment = { id: string; page_url: string };
type Manifest = {
  id: string; title: string; outcome?: string; created_at: string; raw_duration_ms?: number; active_duration_ms?: number;
  markers: Marker[]; segments: Segment[];
};
type ReplayEvent = { timestamp: number; type: number; data?: { source?: number; type?: number; id?: number } };

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
  const markers = manifest.markers.map((marker, index) => `<button class="story-step ${index === 0 ? "active" : ""}" data-marker="${marker.t_ms}"><span class="step-index">${String(index + 1).padStart(2, "0")}</span><span><b>${escape(marker.label)}</b><small>${escape(marker.note ?? "Journey checkpoint")}</small></span><time>${format(marker.t_ms)}</time></button>`).join("") || `<p class="empty">No narration markers were added to this recording.</p>`;
  app.innerHTML = `<header class="app-header"><a class="brand" href="/"><span class="brand-glyph">R</span><span>rec</span><em>replay</em></a><div class="session-chip"><span class="live-dot"></span> stakeholder-ready walkthrough</div><div class="header-actions"><button class="quiet-button" id="copy-link">Copy timestamp</button><span class="outcome outcome-${escape(manifest.outcome ?? "other")}">${escape(manifest.outcome ?? "recorded")}</span></div></header>
  <main class="workspace"><aside class="story-panel panel"><div class="panel-heading"><p class="kicker">THE STORY</p><h2>${escape(manifest.title)}</h2><p>${format(manifest.active_duration_ms)} guided activity <span>·</span> ${format(manifest.raw_duration_ms)} recorded</p></div><div class="story-steps">${markers}</div><div class="story-footer"><span class="pulse"></span>Idle time is condensed for a focused replay</div></aside>
  <section class="stage"><div class="stage-bar"><div><p class="kicker">LIVE REPLAY</p><strong id="stage-title">${escape(manifest.segments[0] ? readablePath(manifest.segments[0].page_url) : "Recording")}</strong></div><div class="stage-status"><span class="status-orb"></span><span id="stage-status">Paused</span></div></div><div class="browser-stage"><div class="browser-chrome"><i></i><i></i><i></i><span>${escape(manifest.segments[0]?.page_url ?? "")}</span></div><div id="replay" aria-label="Session replay"></div><div class="caption-card" id="caption"><span class="caption-kicker">UP NEXT</span><strong>Press play to begin the walkthrough</strong><p>Interaction details and annotations will appear here.</p></div></div><section class="control-deck" aria-label="Replay controls"><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div><div class="speed-control" role="group" aria-label="Playback speed"><button data-speed="1" class="selected">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button><button data-speed="8">8×</button></div><button class="skip-button active" id="skip"><span>↯</span> Skip idle</button></div><div class="timeline-wrap"><div class="timeline-density" id="density"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Replay timeline" /></div><div class="timeline-labels"><span>START</span><span>PLAYBACK TIMELINE</span><span>END</span></div></section></section>
  <aside class="inspector panel"><div class="inspector-header"><p class="kicker">PRESENTER NOTES</p><h2>What’s happening</h2></div><div class="now-card"><span class="now-badge">NOW</span><strong id="now-title">Ready to play</strong><p id="now-copy">This replay is narrated with meaningful actions and step notes.</p></div><div class="fact-list"><div><span>PLAYBACK</span><b>Idle compressed</b></div><div><span>MARKERS</span><b>${manifest.markers.length} checkpoints</b></div><div><span>RECORDED</span><b>${new Date(manifest.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</b></div></div><div class="segment-picker"><p class="kicker">PAGES</p>${manifest.segments.map((segment, index) => `<button data-segment="${escape(segment.id)}" class="${index === 0 ? "selected" : ""}"><span>${String(index + 1).padStart(2, "0")}</span>${escape(readablePath(segment.page_url))}</button>`).join("")}</div></aside></main>`;
}

async function replay(manifest: Manifest, segmentId: string | undefined) {
  if (!segmentId) return;
  const events = await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segmentId)}`);
  if (events.length < 2) throw new Error("This segment does not have enough events to replay.");
  const mount = document.querySelector<HTMLDivElement>("#replay")!;
  mount.replaceChildren();
  const duration = Math.max(1, events.at(-1)!.timestamp - events[0].timestamp);
  const interactions = events.filter(isInteraction).map((event) => event.timestamp - events[0].timestamp);
  prepareTimeline(manifest, duration, interactions);
  const replayer = new Replayer(events as never[], {
    root: mount,
    skipInactive: true,
    showWarning: false,
    mouseTail: { duration: 420, lineWidth: 2, strokeStyle: "rgba(106, 87, 255, .45)" },
    insertStyleRules: [".rec-focus-target{outline:3px solid #6956ff!important;outline-offset:3px!important;box-shadow:0 0 0 7px rgba(105,86,255,.18)!important;border-radius:4px!important;transition:outline .12s ease!important}"]
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
    // Targets live inside rrweb's replay iframe, so an `instanceof Element`
    // check against the outer document would reject otherwise valid nodes.
    if (!isElementLike(target)) return;
    target.classList.remove("rec-focus-target");
    void target.getBoundingClientRect();
    target.classList.add("rec-focus-target");
    window.setTimeout(() => target.classList.remove("rec-focus-target"), 900);
    const label = readableTarget(target);
    setActionCaption(`Clicked ${label}`, "The selected control is highlighted in the replay for clarity.");
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
  document.querySelectorAll<HTMLButtonElement>("[data-marker]").forEach((button) => button.onclick = () => seek(replayer, Number(button.dataset.marker), true));
  document.querySelectorAll<HTMLButtonElement>("[data-segment]").forEach((button) => button.onclick = () => {
    document.querySelectorAll("[data-segment]").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    document.querySelector<HTMLElement>("#stage-title")!.textContent = readablePath(manifest.segments.find((segment) => segment.id === button.dataset.segment)?.page_url ?? "Recording");
    replayer.destroy();
    void replay(manifest, button.dataset.segment);
  });
  scrubber.addEventListener("pointerdown", () => { scrubbing = true; });
  scrubber.addEventListener("input", () => {
    const time = Number(scrubber.value);
    document.querySelector<HTMLElement>("#current-time")!.textContent = format(time);
    syncNarration(manifest, time);
  });
  scrubber.addEventListener("change", () => { scrubbing = false; seek(replayer, Number(scrubber.value), playing); });
  document.querySelector<HTMLButtonElement>("#copy-link")!.onclick = async () => {
    const url = new URL(location.href); url.searchParams.set("t", String(Math.round(Number(scrubber.value) / 1000)));
    await navigator.clipboard?.writeText(url.toString());
    document.querySelector<HTMLButtonElement>("#copy-link")!.textContent = "Copied";
  };
  syncNarration(manifest, 0);
  // rrweb materializes a document only after its first full snapshot. Seeking
  // precisely to that snapshot gives reviewers an opening frame without
  // advancing through the rest of the journey.
  const openingFrame = Math.max(0, (events.find((event) => event.type === 2)?.timestamp ?? events[0].timestamp) - events[0].timestamp);
  replayer.pause(openingFrame);
}

function seek(replayer: Replayer, time: number, shouldPlay: boolean) { shouldPlay ? replayer.play(time) : replayer.pause(time); }

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
  if (!marker) return;
  document.querySelectorAll<HTMLButtonElement>(".story-step").forEach((button) => button.classList.toggle("active", Number(button.dataset.marker) === marker.t_ms));
  setActionCaption(marker.label, marker.note ?? "Narrated journey checkpoint");
}

function setActionCaption(title: string, copy: string) {
  document.querySelector<HTMLElement>("#caption strong")!.textContent = title;
  document.querySelector<HTMLElement>("#caption p")!.textContent = copy;
  document.querySelector<HTMLElement>("#now-title")!.textContent = title;
  document.querySelector<HTMLElement>("#now-copy")!.textContent = copy;
}

function isInteraction(event: ReplayEvent) { return event.type === 3 && event.data?.source === 2; }
type ElementLike = { nodeType: number; classList: DOMTokenList; getBoundingClientRect(): DOMRect; getAttribute(name: string): string | null; textContent: string | null; tagName: string };
function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }
function readableTarget(target: ElementLike) { const text = target.getAttribute("aria-label") || target.textContent?.trim() || target.tagName.toLowerCase(); return `“${text.replace(/\s+/g, " ").slice(0, 64)}”`; }
function readablePath(url: string) { try { const parsed = new URL(url); return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return url; } }
async function request<T>(url: string) { const response = await fetch(url); if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error); return response.json() as Promise<T>; }
function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p class=eyebrow>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
