import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";

type Marker = { t_ms: number; label: string; note?: string };
type Segment = { id: string; page_url: string; clock_offset_ms: number };
type TabEvent = { t_ms: number; segment_id: string; type: "opened" | "focused" | "closed" };
type Manifest = { id: string; title: string; markers: Marker[]; segments: Segment[]; tab_events?: TabEvent[]; raw_duration_ms?: number };
type ReplayEvent = { timestamp: number; type: number; data?: { source?: number; width?: number; height?: number } };

// Keep the default pace in one place so product teams can tune it without
// changing the replay control behavior.
const DEFAULT_PLAYBACK_SPEED = 1.25;
const TAB_FOCUS_DELAY_MS = 700;

const app = document.querySelector<HTMLDivElement>("#app")!;
const id = new URLSearchParams(location.search).get("id");
let activePlayback: AbortController | undefined;
let currentSessionTime = 0;
if (!id) renderError("Choose a recording with `rec open <id>`.");
else void load(id);

async function load(recordingId: string) {
  try {
    currentSessionTime = 0;
    const manifest = await request<Manifest>(`/api/sessions/${encodeURIComponent(recordingId)}/manifest`);
    const eventSets = new Map(await Promise.all(manifest.segments.map(async (segment) => [
      segment.id,
      await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segment.id)}`),
    ] as const)));
    const duration = sessionDuration(manifest, eventSets);
    renderShell(manifest);
    prepareTimeline(manifest.markers, duration, interactionTimes(manifest, eventSets));
    await replay(manifest, eventSets, duration, manifest.segments[0], 0);
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest) {
  const segmentPicker = manifest.segments.length > 1
    ? `<nav class="segment-picker" aria-label="Recorded browser tabs">${manifest.segments.map((segment, index) => `<div class="segment-tab" data-segment="${escape(segment.id)}" title="Opened at ${format(segment.clock_offset_ms)} — ${escape(segment.page_url)}"${index === 0 ? "" : " hidden"}><span>Tab ${index + 1}</span>${escape(segmentLabel(segment.page_url))}</div>`).join("")}</nav>`
    : "";
  app.innerHTML = `<main class="replay-screen" aria-label="${escape(manifest.title)}"><div id="replay" aria-label="Browser session replay"></div><div class="video-shade"></div><div class="playback-state"><span></span><b id="stage-status">Paused</b></div>${segmentPicker}<div class="caption-card" id="caption"><span class="caption-kicker">SESSION REPLAY</span><strong>Press play to begin</strong><p>The timeline follows the full browser recording.</p></div><section class="control-deck" aria-label="Browser replay controls"><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div><div class="speed-control" role="group" aria-label="Playback speed"><button data-speed="${DEFAULT_PLAYBACK_SPEED}" class="selected">${DEFAULT_PLAYBACK_SPEED}×</button><button data-speed="2">2×</button><button data-speed="4">4×</button><button data-speed="8">8×</button></div><button class="skip-button active" id="skip"><span>↯</span> Skip idle</button></div><div class="timeline-wrap"><div class="timeline-density" id="density"></div><div class="timeline-progress" id="timeline-progress"></div><div class="timeline-playhead" id="timeline-playhead" aria-hidden="true"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Browser session timeline" /></div></section></main>`;
}

async function replay(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, duration: number, segment: Segment | undefined, requestedSessionTime: number, autoplay = false) {
  if (!segment) return;
  activePlayback?.abort();
  const lifetime = new AbortController();
  activePlayback = lifetime;
  const events = eventSets.get(segment.id) ?? [];
  if (events.length < 2) throw new Error("This segment does not have enough events to replay.");
  const mount = document.querySelector<HTMLDivElement>("#replay")!;
  mount.replaceChildren();
  const tabDuration = Math.max(1, events.at(-1)!.timestamp - events[0].timestamp);
  const tabStart = segment.clock_offset_ms;
  const tabEnd = tabStart + tabDuration;
  const viewport = recordingViewport(events);
  const replayer = new Replayer(events as never[], {
    root: mount, skipInactive: true, showWarning: false, speed: DEFAULT_PLAYBACK_SPEED,
    mouseTail: { duration: 420, lineWidth: 2, strokeStyle: "rgba(106, 87, 255, .45)" },
    insertStyleRules: [".rec-focus-target{outline:3px solid #6956ff!important;outline-offset:3px!important;box-shadow:0 0 0 7px rgba(105,86,255,.18)!important;border-radius:4px!important}"]
  });
  fitReplay(mount, replayer, viewport);
  window.addEventListener("resize", () => fitReplay(mount, replayer, viewport), { signal: lifetime.signal });
  let playing = false;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let bridgingTabs = false;
  let tabFocusTimer: number | undefined;
  const scrubber = document.querySelector<HTMLInputElement>("#scrubber")!;
  const nextFocus = nextFocusForSegment(manifest, segment.id, requestedSessionTime);
  const updateTimelinePosition = (time: number) => {
    const position = clamp(time / duration * 100, 0, 100);
    currentSessionTime = time;
    revealTabs(manifest, time);
    scrubber.value = String(time);
    document.querySelector<HTMLElement>("#timeline-progress")!.style.width = `${position}%`;
    document.querySelector<HTMLElement>("#timeline-playhead")!.style.left = `${position}%`;
    document.querySelector<HTMLElement>("#current-time")!.textContent = format(time);
  };
  const playFrom = (time: number) => {
    const start = tabEnd >= duration - 10 && time >= duration - 10 ? tabStart : clamp(time, tabStart, tabEnd);
    updateTimelinePosition(start);
    replayer.play(start - tabStart);
  };
  const pausePlayback = () => {
    if (bridgingTabs) {
      bridgingTabs = false;
      if (tabFocusTimer) window.clearTimeout(tabFocusTimer);
      tabFocusTimer = undefined;
      setPlaying(false);
      return;
    }
    replayer.pause();
  };
  const togglePlayback = () => {
    if (playing) return pausePlayback();
    if (replayer.getCurrentTime() >= tabDuration - 10) {
      void replay(manifest, eventSets, duration, manifest.segments[0], 0, true).catch(renderError);
      return;
    }
    playFrom(Number(scrubber.value));
  };
  scrubber.max = String(duration);
  document.querySelector<HTMLElement>("#total-time")!.textContent = format(duration);
  const setPlaying = (value: boolean) => {
    playing = value;
    document.querySelector<HTMLButtonElement>("#play")!.classList.toggle("is-playing", value);
    document.querySelector<HTMLElement>("#stage-status")!.textContent = value ? "Playing" : "Paused";
  };
  const updateProgress = () => {
    if (lifetime.signal.aborted) return;
    if (!scrubbing && !bridgingTabs) {
      const time = clamp(tabStart + replayer.getCurrentTime(), tabStart, tabEnd);
      updateTimelinePosition(time);
      syncNarration(manifest.markers, time);
      if (playing && nextFocus && time >= nextFocus.t_ms) {
        announceAndFocusNewTab(nextFocus, time);
        return;
      }
    }
    if (playing) requestAnimationFrame(updateProgress);
  };
  replayer.on("start", () => { setPlaying(true); requestAnimationFrame(updateProgress); });
  replayer.on("resume", () => { setPlaying(true); requestAnimationFrame(updateProgress); });
  replayer.on("pause", () => setPlaying(false));
  replayer.on("finish", () => {
    if (nextFocus) void bridgeToNewTab(nextFocus);
    else { setPlaying(false); updateTimelinePosition(tabEnd); }
  });
  replayer.on("mouse-interaction", (payload: unknown) => {
    const target = (payload as { target?: unknown }).target;
    if (!isElementLike(target)) return;
    target.classList.remove("rec-focus-target");
    target.classList.add("rec-focus-target");
    window.setTimeout(() => target.classList.remove("rec-focus-target"), 900);
    setActionCaption(`Clicked ${readableTarget(target)}`, "The selected control is highlighted in the replay.");
  });
  document.querySelector<HTMLButtonElement>("#play")!.onclick = togglePlayback;
  document.querySelector<HTMLButtonElement>("#skip")!.onclick = () => {
    replayer.setConfig({ skipInactive: !replayer.config.skipInactive });
    document.querySelector<HTMLButtonElement>("#skip")!.classList.toggle("active", replayer.config.skipInactive);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((button) => button.onclick = () => {
    document.querySelector(".speed-control .selected")?.classList.remove("selected");
    button.classList.add("selected");
    replayer.setConfig({ speed: Number(button.dataset.speed) });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marker]").forEach((button) => button.onclick = () => {
    const time = Number(button.dataset.marker);
    const target = segmentAtTime(manifest, eventSets, time);
    if (target && target.id !== segment.id) void replay(manifest, eventSets, duration, target, time).catch(renderError);
    else playFrom(time);
  });
  document.querySelectorAll<HTMLElement>("[data-segment]").forEach((button) => {
    const selected = button.dataset.segment === segment.id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  const beginScrub = () => {
    if (scrubbing) return;
    scrubbing = true;
    resumeAfterScrub = playing;
    if (playing) pausePlayback();
  };
  scrubber.addEventListener("pointerdown", beginScrub, { signal: lifetime.signal });
  scrubber.addEventListener("input", () => {
    beginScrub();
    const time = Number(scrubber.value);
    updateTimelinePosition(time);
    syncNarration(manifest.markers, time);
  }, { signal: lifetime.signal });
  scrubber.addEventListener("change", () => {
    scrubbing = false;
    const shouldResume = resumeAfterScrub;
    resumeAfterScrub = false;
    const time = Number(scrubber.value);
    const target = segmentAtTime(manifest, eventSets, time);
    if (target && target.id !== segment.id) {
      void replay(manifest, eventSets, duration, target, time, shouldResume).catch(renderError);
      return;
    }
    shouldResume ? playFrom(time) : replayer.pause(clamp(time, tabStart, tabEnd) - tabStart);
  }, { signal: lifetime.signal });
  const onPlaybackKey = (event: KeyboardEvent) => {
    if ((event.key !== "Enter" && event.key !== " ") || event.repeat || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    togglePlayback();
  };
  window.addEventListener("keydown", onPlaybackKey, { capture: true, signal: lifetime.signal });
  const frameWindows = new Set<Window>();
  const attachFrameKeyboard = () => {
    const frameWindow = replayer.iframe.contentWindow;
    if (!frameWindow || frameWindows.has(frameWindow)) return;
    frameWindows.add(frameWindow);
    frameWindow.addEventListener("keydown", onPlaybackKey, true);
  };
  replayer.iframe.addEventListener("load", attachFrameKeyboard, { signal: lifetime.signal });
  replayer.on("fullsnapshot-rebuilded", attachFrameKeyboard);
  lifetime.signal.addEventListener("abort", () => {
    if (tabFocusTimer) window.clearTimeout(tabFocusTimer);
    frameWindows.forEach((frameWindow) => frameWindow.removeEventListener("keydown", onPlaybackKey, true));
  }, { once: true });
  const switchToNewTab = async (focus: TabEvent, time: number) => {
    const tab = manifest.segments.find((item) => item.id === focus.segment_id);
    if (!tab) return;
    bridgingTabs = true;
    tabFocusTimer = undefined;
    updateTimelinePosition(Math.max(focus.t_ms, time));
    await replay(manifest, eventSets, duration, tab, Math.max(focus.t_ms, time), true);
  };
  const announceAndFocusNewTab = (focus: TabEvent, time: number) => {
    if (bridgingTabs) return;
    bridgingTabs = true;
    updateTimelinePosition(Math.max(focus.t_ms, time));
    setPlaying(true);
    tabFocusTimer = window.setTimeout(() => {
      if (lifetime.signal.aborted || !bridgingTabs || !playing) return;
      void switchToNewTab(focus, Math.max(focus.t_ms, currentSessionTime));
    }, TAB_FOCUS_DELAY_MS);
  };
  const bridgeToNewTab = async (focus: TabEvent) => {
    if (bridgingTabs) return;
    bridgingTabs = true;
    if (replayer.config.skipInactive) {
      bridgingTabs = false;
      announceAndFocusNewTab(focus, focus.t_ms);
      return;
    }
    const bridgeStart = currentSessionTime;
    const wallStart = performance.now();
    const advance = () => {
      if (lifetime.signal.aborted || !bridgingTabs || !playing) return;
      const elapsed = (performance.now() - wallStart) * Number(replayer.config.speed);
      const time = Math.min(focus.t_ms, bridgeStart + elapsed);
      updateTimelinePosition(time);
      syncNarration(manifest.markers, time);
      if (time >= focus.t_ms) {
        bridgingTabs = false;
        announceAndFocusNewTab(focus, time);
      }
      else requestAnimationFrame(advance);
    };
    setPlaying(true);
    requestAnimationFrame(advance);
  };
  syncNarration(manifest.markers, requestedSessionTime);
  const openingFrame = Math.max(0, (events.find((event) => event.type === 2)?.timestamp ?? events[0].timestamp) - events[0].timestamp);
  const localTime = clamp(requestedSessionTime - tabStart, openingFrame, tabDuration);
  if (autoplay) playFrom(tabStart + localTime);
  else {
    replayer.pause(localTime);
    updateTimelinePosition(tabStart + localTime);
  }
}

function prepareTimeline(markers: Marker[], duration: number, interactions: number[]) {
  const density = document.querySelector<HTMLElement>("#density")!;
  const buckets = Array.from({ length: 72 }, () => 0);
  interactions.forEach((time) => { buckets[Math.min(buckets.length - 1, Math.floor(time / duration * buckets.length))] += 1; });
  const max = Math.max(1, ...buckets);
  density.innerHTML = buckets.map((count) => `<i style="--level:${Math.max(.08, count / max)}"></i>`).join("");
  document.querySelector<HTMLElement>("#timeline-markers")!.innerHTML = markers.map((marker) => `<button data-marker="${marker.t_ms}" title="${escape(marker.label)}" style="left:${clamp(marker.t_ms / duration * 100, 1, 99)}%"><span></span></button>`).join("");
}

function syncNarration(markers: Marker[], time: number) {
  const marker = [...markers].reverse().find((item) => item.t_ms <= time + 450);
  if (marker) setActionCaption(marker.label, marker.note ?? "Narrated journey checkpoint");
}
function sessionDuration(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const eventEnd = Math.max(1, ...manifest.segments.map((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    return segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? 0) - (events[0]?.timestamp ?? 0));
  }));
  return Math.max(manifest.raw_duration_ms ?? 0, eventEnd);
}
function interactionTimes(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  return manifest.segments.flatMap((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    return events.filter(isInteraction).map((event) => segment.clock_offset_ms + event.timestamp - started);
  });
}
function segmentAtTime(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, time: number) {
  const focused = [...tabEvents(manifest)].reverse().find((event) => event.type === "focused" && event.t_ms <= time && !closedAt(manifest, event.segment_id, time));
  const focusedSegment = manifest.segments.find((segment) => segment.id === focused?.segment_id);
  if (focusedSegment) return focusedSegment;
  return [...manifest.segments].sort((left, right) => right.clock_offset_ms - left.clock_offset_ms).find((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const end = segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? 0) - (events[0]?.timestamp ?? 0));
    return time >= segment.clock_offset_ms && time <= end && !closedAt(manifest, segment.id, time);
  });
}
function revealTabs(manifest: Manifest, time: number) {
  document.querySelectorAll<HTMLElement>("[data-segment]").forEach((button) => {
    const segment = manifest.segments.find((item) => item.id === button.dataset.segment);
    const openedAt = tabEvents(manifest).find((event) => event.type === "opened" && event.segment_id === segment?.id)?.t_ms ?? segment?.clock_offset_ms ?? 0;
    button.hidden = Boolean(segment && (openedAt > time || closedAt(manifest, segment.id, time)));
  });
}
function tabEvents(manifest: Manifest) {
  if (manifest.tab_events?.length) return [...manifest.tab_events].sort((left, right) => left.t_ms - right.t_ms);
  return manifest.segments.flatMap((segment) => [
    { type: "opened" as const, segment_id: segment.id, t_ms: segment.clock_offset_ms },
    { type: "focused" as const, segment_id: segment.id, t_ms: segment.clock_offset_ms },
  ]);
}
function nextFocusForSegment(manifest: Manifest, segmentId: string, after: number) {
  return tabEvents(manifest).find((event) => event.type === "focused" && event.segment_id !== segmentId && event.t_ms > after);
}
function closedAt(manifest: Manifest, segmentId: string, time: number) {
  return tabEvents(manifest).some((event) => event.type === "closed" && event.segment_id === segmentId && event.t_ms <= time);
}
function segmentLabel(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`;
  } catch { return pageUrl; }
}
function setActionCaption(title: string, copy: string) { document.querySelector<HTMLElement>("#caption strong")!.textContent = title; document.querySelector<HTMLElement>("#caption p")!.textContent = copy; }
function isInteraction(event: ReplayEvent) { return event.type === 3 && event.data?.source === 2; }
function recordingViewport(events: ReplayEvent[]) {
  const meta = events.find((event) => event.type === 4 && event.data?.width && event.data?.height);
  return { width: meta?.data?.width ?? 1280, height: meta?.data?.height ?? 720 };
}
function fitReplay(mount: HTMLElement, replayer: Replayer, viewport: { width: number; height: number }) {
  const scale = Math.min(mount.clientWidth / viewport.width, mount.clientHeight / viewport.height);
  replayer.wrapper.style.width = `${viewport.width}px`;
  replayer.wrapper.style.height = `${viewport.height}px`;
  replayer.wrapper.style.transform = `scale(${scale})`;
}
function isTextEntryTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName ?? "");
}
type ElementLike = { nodeType: number; classList: DOMTokenList; getAttribute(name: string): string | null; textContent: string | null; tagName: string };
function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }
function readableTarget(target: ElementLike) { const text = target.getAttribute("aria-label") || target.textContent?.trim() || target.tagName.toLowerCase(); return `“${text.replace(/\s+/g, " ").slice(0, 64)}”`; }
async function request<T>(url: string) { const response = await fetch(url); if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error); return response.json() as Promise<T>; }
function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
