import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";
import { closeChat, initChat, registerReplayControl, wireChatToggle } from "./chat.js";

type Marker = { t_ms: number; label: string; note?: string; placement?: "after_previous" | "before_next"; color?: "yellow" | "green" };
type Segment = { id: string; page_url: string; clock_offset_ms: number };
type TabEvent = { t_ms: number; segment_id: string; type: "opened" | "focused" | "closed" };
type NavigationEvent = { segment_id: string; kind: "reload" | "navigate"; started_at_ms: number; committed_at_ms: number; ready_at_ms: number; from_url: string; to_url: string };
type IdleMode = "cut" | "fast_forward" | "preserve";
type ReplayDefaults = { idle_mode: IdleMode; idle_retained_ms: number; idle_fast_forward_speed: number; default_speed: number };
type Manifest = { id: string; title: string; created_at?: string; outcome?: string; notes?: string; markers: Marker[]; segments: Segment[]; tab_events?: TabEvent[]; navigation_events?: NavigationEvent[]; raw_duration_ms?: number; replay_defaults?: ReplayDefaults };
type ReplayEvent = { timestamp: number; type: number; data?: { source?: number; type?: number; href?: string; width?: number; height?: number; text?: string; id?: number; x?: number; y?: number; recSynthetic?: "approach"; positions?: { x: number; y: number; id?: number; timeOffset?: number }[] } };
type IdleRange = { start: number; end: number };
type TimelineIdleRange = IdleRange & { originalDuration: number; mode: IdleMode; speed: number };
type PlaybackProjection = { manifest: Manifest; eventSets: Map<string, ReplayEvent[]>; duration: number; activities: number[]; playbackEnd: number; idleRanges: TimelineIdleRange[]; toPlayback(time: number): number; toRaw(time: number): number };

// Keep the default pace in one place so product teams can tune it without
// changing the replay control behavior.
const DEFAULT_PLAYBACK_SPEED = 1.15;
const DEFAULT_REPLAY_DEFAULTS: ReplayDefaults = { idle_mode: "cut", idle_retained_ms: 2_000, idle_fast_forward_speed: 8, default_speed: DEFAULT_PLAYBACK_SPEED };
const TAB_FOCUS_DELAY_MS = 700;
const IDLE_THRESHOLD_MS = 3_000;
const RELOAD_CONTEXT_MS = 750;
const CURSOR_APPROACH_MS = 420;
const KEYSTROKE_PACE_MS = 85;
const REFRESH_INDICATOR_MS = 1_100;
const MIN_REFRESH_INDICATOR_MS = 160;
const MAX_REFRESH_INDICATOR_MS = 1_500;
const TIMELINE_TOOLTIP_DELAY_MS = 550;
const CAPTION_LINGER_MS = 4_500;
const UI_IDLE_MS = 3_200;
const SEEK_STEP_MS = 5_000;
// Arrow-key marker navigation buffers. Going back, treat any marker within this
// distance at or behind the playhead as the one we're "on" and skip it, so a
// playhead that has drifted just past a marker still steps to the genuinely
// previous one instead of snapping back onto it. Going forward only skips the
// marker we're sitting on so an upcoming marker stays reachable.
const MARKER_BACK_BUFFER_MS = 600;
const MARKER_FWD_SLOP_MS = 60;
const CAMERA_ZOOM = 1.45;
const CAMERA_HOLD_MS = 3_800;
const CAMERA_EASE_PER_S = 4.2;
// Camera inputs arriving from rrweb's seek reconstruction are historical; only
// events cast near the live playhead may steer the camera.
const CAMERA_SYNC_WINDOW_MS = 800;

const app = document.querySelector<HTMLDivElement>("#app")!;
const id = new URLSearchParams(location.search).get("id");
let activePlayback: AbortController | undefined;
let currentSessionTime = 0;
let lastNarrationKey: string | undefined;
let captionTimer: number | undefined;
let chaptersOpen: boolean | undefined;
let introDismissed = false;
// The auto-zoom camera ships dark: it only exists when the rec-camera flag is
// switched on, via ?camera=on (persisted) or localStorage rec-camera=on.
const cameraFeature = resolveCameraFlag();
let cameraZoomEnabled = cameraFeature && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function resolveCameraFlag() {
  const requested = new URLSearchParams(location.search).get("camera");
  try {
    if (requested === "on" || requested === "1") { localStorage.setItem("rec-camera", "on"); return true; }
    if (requested === "off" || requested === "0") { localStorage.setItem("rec-camera", "off"); return false; }
    return localStorage.getItem("rec-camera") === "on";
  } catch { return requested === "on" || requested === "1"; }
}
let shareAvailable = false;
let shareUrl: string | undefined;
// The chat panel and its tools speak raw recording time; the active playback
// projection translates it. Refreshed by every present().
let rawToPlayback: (time: number) => number = (time) => time;
let playbackToRaw: (time: number) => number = (time) => time;
if (!id) renderError("Choose a recording with `rec open <id>`.");
else {
  maintainReplayLease();
  void load(id);
}
app.addEventListener("pointermove", wakeInterface);
app.addEventListener("pointerdown", wakeInterface);
window.addEventListener("keydown", wakeInterface, true);
app.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".deck-menu")) closeDeckMenus();
});
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDeckMenus(); }, true);

function maintainReplayLease() {
  let leaseId: string | undefined;
  let renewTimer: number | undefined;
  const release = () => {
    if (renewTimer) window.clearInterval(renewTimer);
    renewTimer = undefined;
    if (!leaseId) return;
    void fetch("/api/leases/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: leaseId }),
      keepalive: true,
    }).catch(() => undefined);
    leaseId = undefined;
  };
  const renew = () => {
    if (!leaseId) return;
    void fetch("/api/leases/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: leaseId, ttl_ms: 30_000 }),
    }).then((response) => { if (!response.ok) release(); }).catch(release);
  };
  void fetch("/api/leases/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "rec-player", kind: "replay", ttl_ms: 30_000 }),
  }).then(async (response) => {
    if (!response.ok) return;
    const value = await response.json() as { lease_id?: string };
    if (!value.lease_id) return;
    leaseId = value.lease_id;
    renewTimer = window.setInterval(renew, 10_000);
  }).catch(() => undefined);
  window.addEventListener("pagehide", release, { once: true });
}

async function load(recordingId: string) {
  try {
    currentSessionTime = 0;
    lastNarrationKey = undefined;
    introDismissed = false;
    shareUrl = undefined;
    shareAvailable = await detectShareAvailability();
    void initChat(recordingId, () => {
      // The assistant and the chapters list share the right edge; opening one
      // yields it to the other.
      const chapters = document.querySelector<HTMLButtonElement>("#chapters-toggle");
      if (chapters?.classList.contains("is-open")) chapters.click();
    });
    const manifest = await request<Manifest>(`/api/sessions/${encodeURIComponent(recordingId)}/manifest`);
    const eventSets = new Map(await Promise.all(manifest.segments.map(async (segment) => [
      segment.id,
      humanizeEvents(await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segment.id)}`)),
    ] as const)));
    const resolvedManifest = { ...manifest, markers: resolveMarkerTimes(manifest, eventSets) };
    const replayDefaults = resolvedReplayDefaults(manifest.replay_defaults);
    let idleMode = replayDefaults.idle_mode;
    let playbackSpeed = replayDefaults.default_speed;
    const present = async (rawTime = 0, autoplay = false) => {
      const projection = projectPlayback(resolvedManifest, eventSets, idleMode, replayDefaults);
      rawToPlayback = projection.toPlayback;
      playbackToRaw = projection.toRaw;
      activePlayback?.abort();
      renderShell(projection.manifest, idleMode, replayDefaults, playbackSpeed);
      prepareTimeline(projection.manifest.markers, projection.manifest.navigation_events ?? [], projection.duration, projection.activities, projection.playbackEnd, projection.idleRanges);
      installTimelineTooltips();
      wireShareControl(resolvedManifest.id);
      wireChatToggle(document.querySelector<HTMLButtonElement>("#chat-toggle"));
      wireChapters();
      wireSessionCards();
      wireDeckMenus();
      await replay(projection.manifest, projection.eventSets, projection.duration, projection.manifest.segments[0], projection.toPlayback(rawTime), autoplay, (nextMode, requestedTime, shouldAutoplay) => {
        idleMode = nextMode;
        void present(projection.toRaw(requestedTime), shouldAutoplay).catch(renderError);
      }, playbackSpeed, (nextSpeed) => { playbackSpeed = nextSpeed; });
    };
    await present();
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest, idleMode: IdleMode, defaults: ReplayDefaults, playbackSpeed: number) {
  chaptersOpen ??= manifest.markers.length > 1 && window.matchMedia("(min-width: 1100px)").matches;
  const segmentPicker = manifest.segments.length > 1
    ? `<nav class="segment-picker" aria-label="Recorded browser tabs">${manifest.segments.map((segment, index) => `<div class="segment-tab" data-segment="${escape(segment.id)}" title="Opened at ${format(segment.clock_offset_ms)} — ${escape(segment.page_url)}"${index === 0 ? "" : " hidden"}><span>Tab ${index + 1}</span>${escape(segmentLabel(segment.page_url))}</div>`).join("")}</nav>`
    : "";
  // The tuned default pace is the recording's "natural" speed — present it as
  // 1× instead of leaking the internal multiplier into the control.
  const speedOptions = [...new Set([0.25, 0.5, defaults.default_speed, 2, 4, 8])]
    .map((speed) => ({ speed, label: speed === defaults.default_speed ? "1×" : `${speed}×` }));
  const currentSpeedLabel = speedOptions.find((option) => option.speed === playbackSpeed)?.label ?? `${playbackSpeed}×`;
  const speedMenu = `<div class="deck-menu" id="speed-menu"><button class="menu-button" id="speed-button" type="button" aria-haspopup="true" aria-expanded="false"><b id="speed-current">${currentSpeedLabel}</b><i aria-hidden="true">▾</i></button><div class="menu-pop" hidden><span class="menu-label">Speed</span><div class="menu-options menu-options-column">${speedOptions.map(({ speed, label }) => `<button data-speed="${speed}" data-speed-label="${label}"${speed === playbackSpeed ? " class=\"selected\"" : ""}>${label}</button>`).join("")}</div></div></div>`;
  const idleControls = ([
    ["cut", "Cut"],
    ["fast_forward", `${defaults.idle_fast_forward_speed}×`],
    ["preserve", "Keep"],
  ] as const).map(([mode, label]) => `<button data-idle-mode="${mode}"${mode === idleMode ? " class=\"selected\"" : ""}>${label}</button>`).join("");
  const cameraSection = cameraFeature
    ? `<span class="menu-label">Auto zoom</span><div class="menu-options">${([["auto", "Auto"], ["off", "Off"]] as const).map(([mode, label]) => `<button data-camera-mode="${mode}"${(mode === "auto") === cameraZoomEnabled ? " class=\"selected\"" : ""}>${label}</button>`).join("")}</div>`
    : "";
  const settingsMenu = `<div class="deck-menu" id="settings-menu"><button class="menu-button menu-button-icon" id="settings-button" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Replay settings"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button><div class="menu-pop" hidden><span class="menu-label">Idle time</span><div class="menu-options">${idleControls}</div><span class="menu-note" id="idle-summary"></span>${cameraSection}</div></div>`;
  const shareControl = shareAvailable
    ? `<div class="share-control" id="share-control"><button class="share-button" id="share" type="button">Share</button></div>`
    : "";
  const chatToggle = `<button class="chat-toggle" id="chat-toggle" type="button" hidden aria-expanded="false" title="Ask the replay assistant"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2l2.1 6.2a2 2 0 0 0 1.3 1.3L21.5 12l-6.1 2.5a2 2 0 0 0-1.3 1.3L12 22l-2.1-6.2a2 2 0 0 0-1.3-1.3L2.5 12l6.1-2.5a2 2 0 0 0 1.3-1.3z"/></svg>Ask AI</button>`;
  const chaptersToggle = manifest.markers.length
    ? `<button class="chapters-toggle" id="chapters-toggle" type="button" aria-controls="chapters-panel" aria-expanded="false">Chapters<b>${manifest.markers.length}</b></button>`
    : "";
  const sessionMeta = sessionMetaMarkup(manifest);
  const introCard = introDismissed
    ? ""
    : `<div class="session-overlay is-visible" id="intro-card"><div class="session-card"><span class="session-kicker"><i></i>Rec replay</span><h1>${escape(manifest.title)}</h1>${sessionMeta}<p class="session-hint">Press play — or space — to watch the recorded journey</p></div></div>`;
  const endCard = `<div class="session-overlay" id="end-card"><div class="session-card"><span class="session-kicker"><i></i>Replay complete</span><h1>${escape(manifest.title)}</h1>${sessionMeta}${manifest.notes ? `<p class="session-notes">${escape(manifest.notes)}</p>` : ""}<button class="watch-again" id="watch-again" type="button">Watch again</button></div></div>`;
  const chaptersPanel = manifest.markers.length
    ? `<aside class="chapters-panel" id="chapters-panel" aria-label="Recording chapters"><header>Chapters<span>${manifest.markers.length}</span></header><ol>${manifest.markers.map((marker) => `<li><button type="button" data-chapter="${marker.t_ms}"${marker.color ? ` data-chapter-color="${marker.color}"` : ""} aria-current="false"><b>${format(marker.t_ms)}</b><span><strong>${escape(marker.label)}</strong>${marker.note ? `<p>${escape(marker.note)}</p>` : ""}</span></button></li>`).join("")}</ol></aside>`
    : "";
  app.innerHTML = `<main class="replay-screen" aria-label="${escape(manifest.title)}"><div id="replay" aria-label="Browser session replay"></div><div class="video-shade"></div><div class="state-flash" id="state-flash" aria-hidden="true"><span></span></div><b id="stage-status" class="sr-only" role="status">Paused</b>${segmentPicker}<div class="refresh-indicator" id="refresh-indicator" role="status" aria-live="polite"><span class="refresh-spinner" aria-hidden="true"></span><strong id="refresh-label">Page is refreshing</strong></div><div class="caption-card" id="caption" aria-live="polite"><strong></strong><p hidden></p></div>${introCard}${endCard}<section class="control-deck" aria-label="Browser replay controls"><div class="deck-island"><div class="timeline-wrap"><div class="timeline-chapters" id="chapter-track" aria-hidden="true"></div><div class="timeline-idle" id="idle-ranges" aria-label="Idle periods"></div><div class="timeline-navigations" id="navigation-events" aria-label="Page navigations"></div><div class="timeline-density" id="density"></div><div class="timeline-progress" id="timeline-progress"></div><div class="timeline-playhead" id="timeline-playhead" aria-hidden="true"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Browser session timeline" /></div><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div>${speedMenu}${settingsMenu}${shareControl}${chatToggle}${chaptersToggle}</div></div></section>${chaptersPanel}<div class="timeline-tooltip" id="timeline-tooltip" role="tooltip" aria-hidden="true"></div></main>`;
}

async function detectShareAvailability() {
  try {
    const health = await request<{ share_available?: boolean }>("/health");
    return health.share_available === true;
  } catch { return false; }
}

function wireShareControl(recordingId: string) {
  const button = document.querySelector<HTMLButtonElement>("#share");
  if (button) button.onclick = () => void shareRecording(recordingId, button);
  const copy = document.querySelector<HTMLButtonElement>("#share-copy");
  if (copy) copy.onclick = () => copyShareLink(copy);
}

function copyShareLink(button: HTMLButtonElement) {
  const clipboard = navigator.clipboard;
  if (!shareUrl || !clipboard) { setActionCaption("Copy the link", "Select the share link and copy it manually."); return; }
  void clipboard.writeText(shareUrl)
    .then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = "Copy"; }, 1600);
      setActionCaption("Link copied", "The share link is on your clipboard.");
    })
    .catch(() => setActionCaption("Copy the link", "Select the share link and copy it manually."));
}

async function shareRecording(recordingId: string, button: HTMLButtonElement) {
  // The share link is a means to an end, not something to read — swap the button
  // for a brief spinner, then drop the link straight on the clipboard and confirm
  // with a caption rather than showing the URL.
  button.disabled = true;
  button.innerHTML = `<span class="share-spinner" aria-hidden="true"></span>`;
  try {
    const result = await request<{ shareUrl: string }>(`/api/sessions/${encodeURIComponent(recordingId)}/share`, { method: "POST" });
    shareUrl = result.shareUrl;
    try {
      await navigator.clipboard.writeText(shareUrl);
      button.textContent = "Share";
      button.disabled = false;
      setActionCaption("Link copied", "The share link is on your clipboard.");
    } catch {
      // Clipboard blocked (e.g. the browser dropped the click's user activation
      // across the network wait) — degrade to a copyable link so it isn't lost.
      const control = document.querySelector<HTMLElement>("#share-control");
      if (control) control.innerHTML = shareResultMarkup(shareUrl);
      wireShareControl(recordingId);
      setActionCaption("Share link ready", "Copy it from the control bar.");
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = "Share";
    setActionCaption("Share failed", error instanceof Error ? error.message : String(error));
  }
}

function shareResultMarkup(url: string) {
  return `<a class="share-link" href="${escape(url)}" target="_blank" rel="noopener" title="${escape(url)}">${escape(url)}</a><button class="share-button" id="share-copy" type="button">Copy</button>`;
}

async function replay(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, duration: number, segment: Segment | undefined, requestedSessionTime: number, autoplay = false, onIdleModeChange?: (mode: IdleMode, requestedTime: number, autoplay: boolean) => void, playbackSpeed = DEFAULT_PLAYBACK_SPEED, onPlaybackSpeedChange?: (speed: number) => void) {
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
  let selectedPlaybackSpeed = playbackSpeed;
  let replayDocumentKeyboardHandler: ((event: KeyboardEvent) => void) | undefined;
  const replayer = new Replayer(events as never[], {
    // rrweb only skips when a later mouse/input event exists. Rec owns this
    // policy so navigation, reload, and verification waits are accelerated too.
    root: mount, skipInactive: false, showWarning: false, speed: selectedPlaybackSpeed,
    mouseTail: false,
    plugins: [{
      onBuild(node: Node) {
        if (node.nodeType !== Node.DOCUMENT_NODE) return;
        node.addEventListener("keydown", (event) => replayDocumentKeyboardHandler?.(event as KeyboardEvent), true);
      },
    }] as never[],
    insertStyleRules: [".rec-focus-target{outline:2px solid rgba(105,86,255,.9)!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(105,86,255,.16)!important;border-radius:4px!important}"]
  });
  fitReplay(mount, replayer, viewport);
  const camera = createCamera(mount, replayer, viewport, lifetime);
  revealCursorOnFirstMove(replayer, lifetime);
  window.addEventListener("resize", () => { fitReplay(mount, replayer, viewport); camera.apply(); }, { signal: lifetime.signal });
  let playing = false;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let bridgingTabs = false;
  let tabFocusTimer: number | undefined;
  let refreshTimer: number | undefined;
  let frameKeyboardTimer: number | undefined;
  let visibleNavigation: NavigationEvent | undefined;
  let refreshPinned = false;
  const navigationEvents = (manifest.navigation_events ?? []).filter((event) => event.segment_id === segment.id).sort((left, right) => left.started_at_ms - right.started_at_ms);
  let lastNavigationCheck = requestedSessionTime;
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
    updateActiveMarker(time);
  };
  const playFrom = (time: number) => {
    // Real playback is starting — the session cards yield to the recording.
    // rrweb's seek-while-paused also emits start/pause internally, so the
    // cards cannot key off setPlaying.
    dismissIntro();
    setEndCard(false);
    const start = tabEnd >= duration - 10 && time >= duration - 10 ? tabStart : clamp(time, tabStart, tabEnd);
    // A direct marker/timeline jump is a new playback baseline. Do not announce
    // navigation transitions that were crossed before the selected point.
    lastNavigationCheck = start;
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
      void replay(manifest, eventSets, duration, manifest.segments[0], 0, true, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
      return;
    }
    playFrom(Number(scrubber.value));
  };
  scrubber.max = String(duration);
  document.querySelector<HTMLElement>("#total-time")!.textContent = format(duration);
  let lastPlayState: boolean | undefined;
  const setPlaying = (value: boolean) => {
    playing = value;
    document.querySelector<HTMLButtonElement>("#play")!.classList.toggle("is-playing", value);
    document.querySelector<HTMLElement>("#stage-status")!.textContent = value ? "Playing" : "Paused";
    scheduleCaptionFade();
    wakeInterface();
    camera.setPlaying(value);
    if (lastPlayState !== undefined && lastPlayState !== value) flashPlayState(value);
    lastPlayState = value;
  };
  const hideRefresh = () => {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    visibleNavigation = undefined;
    refreshPinned = false;
    document.querySelector<HTMLElement>("#refresh-indicator")!.classList.remove("is-visible");
  };
  const showRefresh = (navigation: NavigationEvent, pinned = false) => {
    // A page transition is a scene change — the camera pulls back for it.
    camera.reset();
    const indicator = document.querySelector<HTMLElement>("#refresh-indicator")!;
    visibleNavigation = navigation;
    refreshPinned = pinned;
    document.querySelector<HTMLElement>("#refresh-label")!.textContent = navigation.kind === "reload" ? "Page is refreshing" : "Page is navigating";
    indicator.classList.add("is-visible");
    if (refreshTimer) window.clearTimeout(refreshTimer);
    if (pinned) {
      refreshTimer = undefined;
      return;
    }
    const duration = clamp(
      REFRESH_INDICATOR_MS * DEFAULT_PLAYBACK_SPEED / selectedPlaybackSpeed,
      MIN_REFRESH_INDICATOR_MS,
      MAX_REFRESH_INDICATOR_MS,
    );
    refreshTimer = window.setTimeout(() => {
      hideRefresh();
    }, duration);
  };
  // A local reload commonly finishes in a few milliseconds. Preserve that
  // exact span in the manifest, but give it a short, explicit presentation
  // tail so viewers can seek to the transition and understand what happened.
  // Idle projection retains this same context, keeping the timeline and the
  // overlay on one shared interval.
  const navigationPresentationEnd = (event: NavigationEvent) => Math.min(duration, event.ready_at_ms + RELOAD_CONTEXT_MS);
  const activeNavigationAt = (time: number) => navigationEvents.find((event) => event.started_at_ms <= time && time <= navigationPresentationEnd(event));
  const syncNavigationAt = (time: number, pinned: boolean) => {
    const active = activeNavigationAt(time);
    if (active) showRefresh(active, pinned);
    else if (visibleNavigation) hideRefresh();
  };
  const announceNavigations = (time: number) => {
    const active = activeNavigationAt(time);
    if (active) showRefresh(active);
    else {
      if (visibleNavigation) hideRefresh();
      const crossed = navigationEvents.filter((event) => event.started_at_ms > lastNavigationCheck && event.started_at_ms <= time && time <= navigationPresentationEnd(event));
      for (const navigation of crossed) showRefresh(navigation);
    }
    lastNavigationCheck = Math.max(lastNavigationCheck, time);
  };
  const updateProgress = () => {
    if (lifetime.signal.aborted) return;
    // rrweb can replace the iframe document during a full snapshot. Recheck on
    // each playback frame so a focus change never strands the hotkeys.
    attachFrameKeyboard();
    if (!scrubbing && !bridgingTabs) {
      const time = clamp(tabStart + replayer.getCurrentTime(), tabStart, tabEnd);
      updateTimelinePosition(time);
      announceNavigations(time);
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
  replayer.on("pause", () => {
    setPlaying(false);
    syncNavigationAt(currentSessionTime, true);
  });
  replayer.on("finish", () => {
    // A seek (e.g. left-arrow near the end) aborts this replayer and builds a new
    // one. The old instance can still fire a queued finish afterward; ignore it so
    // the end card never reappears over resumed playback.
    if (lifetime.signal.aborted) return;
    if (nextFocus) void bridgeToNewTab(nextFocus);
    else {
      setPlaying(false);
      updateTimelinePosition(tabEnd);
      camera.reset();
      setEndCard(true);
    }
  });
  replayer.on("event-cast", (payload: unknown) => {
    if (!cameraFeature) return;
    const event = payload as ReplayEvent;
    if (event.type !== 3 || !event.data) return;
    const eventTime = sessionEventTime(event, events, tabStart);
    if (eventTime === undefined || Math.abs(eventTime - currentSessionTime) > CAMERA_SYNC_WINDOW_MS) return;
    const data = event.data;
    if (data.source === 2 && (data.type === 2 || data.type === 4) && typeof data.x === "number" && typeof data.y === "number") camera.noteInteraction(data.x, data.y);
    else if (data.source === 1) { const position = data.positions?.at(-1); if (position) camera.trackCursor(position.x, position.y); }
    else if (data.source === 5) camera.refreshHold();
  });
  replayer.on("mouse-interaction", (payload: unknown) => {
    const interaction = payload as { type?: number; target?: unknown; x?: number; y?: number };
    // 2 = click, 4 = double click in rrweb's MouseInteractions enum. Focus,
    // blur, and pointer downs replay silently.
    if (interaction.type !== 2 && interaction.type !== 4) return;
    spawnClickRipple(replayer, interaction);
    const target = interaction.target;
    if (!isElementLike(target)) return;
    target.classList.remove("rec-focus-target");
    target.classList.add("rec-focus-target");
    window.setTimeout(() => target.classList.remove("rec-focus-target"), 900);
  });
  document.querySelector<HTMLButtonElement>("#play")!.onclick = togglePlayback;
  document.querySelectorAll<HTMLButtonElement>("[data-idle-mode]").forEach((button) => button.onclick = () => {
    const mode = button.dataset.idleMode as IdleMode;
    onIdleModeChange?.(mode, currentSessionTime, playing);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-camera-mode]").forEach((button) => button.onclick = () => {
    cameraZoomEnabled = button.dataset.cameraMode === "auto";
    document.querySelectorAll<HTMLButtonElement>("[data-camera-mode]").forEach((item) => item.classList.toggle("selected", item === button));
    camera.setEnabled(cameraZoomEnabled);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((button) => button.onclick = () => {
    document.querySelector("#speed-menu .selected")?.classList.remove("selected");
    button.classList.add("selected");
    const current = document.querySelector<HTMLElement>("#speed-current");
    if (current && button.dataset.speedLabel) current.textContent = button.dataset.speedLabel;
    closeDeckMenus();
    const speed = Number(button.dataset.speed);
    selectedPlaybackSpeed = speed;
    replayer.setConfig({ speed });
    onPlaybackSpeedChange?.(speed);
    if (visibleNavigation) showRefresh(visibleNavigation, refreshPinned);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marker], [data-chapter]").forEach((button) => button.onclick = () => {
    dismissIntro();
    setEndCard(false);
    const time = Number(button.dataset.marker ?? button.dataset.chapter);
    const target = segmentAtTime(manifest, eventSets, time);
    if (target && target.id !== segment.id) void replay(manifest, eventSets, duration, target, time, false, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
    else {
      playFrom(time);
      syncNarration(manifest.markers, time, true);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-segment]").forEach((button) => {
    const selected = button.dataset.segment === segment.id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  const beginScrub = () => {
    if (scrubbing) return;
    scrubbing = true;
    camera.reset();
    resumeAfterScrub = playing;
    if (playing) pausePlayback();
  };
  scrubber.addEventListener("pointerdown", beginScrub, { signal: lifetime.signal });
  scrubber.addEventListener("input", () => {
    beginScrub();
    dismissIntro();
    setEndCard(false);
    const time = Number(scrubber.value);
    updateTimelinePosition(time);
    syncNavigationAt(time, true);
    syncNarration(manifest.markers, time);
  }, { signal: lifetime.signal });
  scrubber.addEventListener("change", () => {
    scrubbing = false;
    const shouldResume = resumeAfterScrub;
    resumeAfterScrub = false;
    const time = Number(scrubber.value);
    const target = segmentAtTime(manifest, eventSets, time) ?? segment;
    void replay(manifest, eventSets, duration, target, time, shouldResume, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
  }, { signal: lifetime.signal });
  const jumpTo = (time: number) => {
    dismissIntro();
    setEndCard(false);
    const clamped = clamp(time, 0, duration);
    const target = segmentAtTime(manifest, eventSets, clamped) ?? segment;
    void replay(manifest, eventSets, duration, target, clamped, playing, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
  };
  const seekBy = (delta: number) => jumpTo(currentSessionTime + delta);
  // Arrow keys hop between chapter markers so viewers land on the moments that
  // matter; with no markers they fall back to a fixed jog. Playback keeps
  // nudging the playhead past the marker just landed on, which used to make a
  // left press snap back onto that same marker. Handle each direction on its own
  // side of the playhead instead: "previous" skips any marker within a buffer at
  // or behind the playhead (absorbing the drift) and takes the one before it,
  // while "next" takes the first marker ahead. A left press never lands forward,
  // and a right press never lands back.
  const jumpToMarker = (direction: -1 | 1) => {
    const times = manifest.markers
      .map((marker) => marker.t_ms)
      .filter((time) => time > 0 && time < duration)
      .sort((left, right) => left - right);
    if (!times.length) { seekBy(direction * SEEK_STEP_MS); return; }
    if (direction < 0) {
      const previous = [...times].reverse().find((time) => time < currentSessionTime - MARKER_BACK_BUFFER_MS);
      jumpTo(previous ?? 0);
    } else {
      const next = times.find((time) => time > currentSessionTime + MARKER_FWD_SLOP_MS);
      jumpTo(next ?? duration);
    }
  };
  const onPlaybackKey = (event: KeyboardEvent) => {
    // The replayed page is a passive playback, so keystrokes must never reach its
    // form fields — only guard against text entry in the player's own chrome
    // (top document), never the recorded content inside the replay iframe.
    if (event.repeat) return;
    if (isTextEntryTarget(event.target) && isMainDocumentTarget(event.target)) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar" || event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      jumpToMarker(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      toggleFullscreen();
    }
  };
  mount.addEventListener("click", () => togglePlayback(), { signal: lifetime.signal });
  replayDocumentKeyboardHandler = onPlaybackKey;
  window.addEventListener("keydown", onPlaybackKey, { capture: true, signal: lifetime.signal });
  const frameWindows = new Set<Window>();
  const frameDocuments = new Set<Document>();
  const attachFrameKeyboard = () => {
    const frameWindow = replayer.iframe.contentWindow;
    if (!frameWindow) return;
    if (!frameWindows.has(frameWindow)) {
      frameWindows.add(frameWindow);
      frameWindow.addEventListener("keydown", onPlaybackKey, true);
    }
    const frameDocument = frameWindow.document;
    if (!frameDocuments.has(frameDocument)) {
      frameDocuments.add(frameDocument);
      frameDocument.addEventListener("keydown", onPlaybackKey, true);
    }
  };
  const refreshFrameKeyboard = () => {
    attachFrameKeyboard();
    if (frameKeyboardTimer) window.clearTimeout(frameKeyboardTimer);
    frameKeyboardTimer = window.setTimeout(attachFrameKeyboard);
  };
  replayer.iframe.addEventListener("load", refreshFrameKeyboard, { signal: lifetime.signal });
  replayer.on("fullsnapshot-rebuilded", refreshFrameKeyboard);
  refreshFrameKeyboard();
  lifetime.signal.addEventListener("abort", () => {
    if (tabFocusTimer) window.clearTimeout(tabFocusTimer);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    // The refresh overlay belongs to the replay instance that emitted the
    // navigation. Seeking replaces that instance, so it must not leak into the
    // newly requested point on the timeline.
    document.querySelector<HTMLElement>("#refresh-indicator")?.classList.remove("is-visible");
    visibleNavigation = undefined;
    refreshPinned = false;
    if (frameKeyboardTimer) window.clearTimeout(frameKeyboardTimer);
    replayDocumentKeyboardHandler = undefined;
    frameWindows.forEach((frameWindow) => frameWindow.removeEventListener("keydown", onPlaybackKey, true));
    frameDocuments.forEach((frameDocument) => frameDocument.removeEventListener("keydown", onPlaybackKey, true));
  }, { once: true });
  const switchToNewTab = async (focus: TabEvent, time: number) => {
    const tab = manifest.segments.find((item) => item.id === focus.segment_id);
    if (!tab) return;
    bridgingTabs = true;
    tabFocusTimer = undefined;
    updateTimelinePosition(Math.max(focus.t_ms, time));
    await replay(manifest, eventSets, duration, tab, Math.max(focus.t_ms, time), true, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange);
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
  // The chat assistant drives playback through this handle. Raw recording
  // times arrive from the model; the projection maps them onto the timeline.
  const urlAtTime = (time: number) => {
    const navigated = [...navigationEvents].reverse().find((event) => event.started_at_ms <= time);
    return navigated?.to_url ?? segment.page_url;
  };
  registerReplayControl({
    seek: async (rawMs, play) => {
      dismissIntro();
      setEndCard(false);
      const projected = clamp(rawToPlayback(rawMs), 0, duration);
      const target = segmentAtTime(manifest, eventSets, projected) ?? segment;
      await replay(manifest, eventSets, duration, target, projected, play, onIdleModeChange, selectedPlaybackSpeed, onPlaybackSpeedChange);
      syncNarration(manifest.markers, projected, true);
      return `Playhead moved to recording time ${format(rawMs)} (${play ? "playing" : "paused"}). The viewer is now looking at this moment.`;
    },
    setPlayback: (action) => {
      if (action === "play" && !playing) togglePlayback();
      else if (action === "pause" && playing) pausePlayback();
      return action === "play" ? "The replay is playing." : "The replay is paused.";
    },
    readScreen: async () => {
      await settleReplayFrame();
      const frameDocument = replayer.iframe.contentDocument;
      const body = frameDocument?.body;
      if (!body) throw new Error("The replay frame is not ready; try seeking first.");
      const text = (body.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      return [
        `URL: ${urlAtTime(currentSessionTime)}`,
        // Inside a collapsed idle gap several raw seconds share one playhead
        // instant, so the mapped-back time is approximate by nature.
        `Recording time: ~${format(playbackToRaw(currentSessionTime))}`,
        "",
        text || "(The page shows no visible text at this moment.)",
      ].join("\n");
    },
    highlight: ({ text, selector }) => {
      const frameDocument = replayer.iframe.contentDocument;
      if (!frameDocument) throw new Error("The replay frame is not ready; try seeking first.");
      let target: Element | null = null;
      if (selector) { try { target = frameDocument.querySelector(selector); } catch { throw new Error("That CSS selector is not valid."); } }
      if (!target && text) target = findElementByText(frameDocument, text);
      if (!target) throw new Error("No matching element is visible at the current moment.");
      target.scrollIntoView({ block: "center", inline: "center" });
      target.classList.remove("rec-focus-target");
      target.classList.add("rec-focus-target");
      window.setTimeout(() => target?.classList.remove("rec-focus-target"), 2_600);
      const label = (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      return `Highlighted <${target.tagName.toLowerCase()}>${label ? ` "${label}"` : ""} for the viewer.`;
    },
  });
  syncNarration(manifest.markers, requestedSessionTime);
  const openingFrame = Math.max(0, (events.find((event) => event.type === 2)?.timestamp ?? events[0].timestamp) - events[0].timestamp);
  const localTime = clamp(requestedSessionTime - tabStart, openingFrame, tabDuration);
  if (autoplay) playFrom(tabStart + localTime);
  else {
    replayer.pause(localTime);
    updateTimelinePosition(tabStart + localTime);
    syncNavigationAt(tabStart + localTime, true);
  }
}

function projectPlayback(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, idleMode: IdleMode, defaults: ReplayDefaults): PlaybackProjection {
  const playbackEnd = eventEndTime(manifest, eventSets);
  const activities = activityTimes(manifest, eventSets);
  const navigationEvents = resolvedNavigationEvents(manifest, eventSets);
  const rawIdle = idleRanges(activities, playbackEnd);
  const scale = (range: IdleRange) => idleScale(range, idleMode, defaults);
  const toPlayback = (time: number) => {
    let removed = 0;
    for (const range of rawIdle) {
      const projectedDuration = (range.end - range.start) * scale(range);
      if (time >= range.end) { removed += range.end - range.start - projectedDuration; continue; }
      if (time > range.start) return range.start - removed + (time - range.start) * scale(range);
      break;
    }
    return time - removed;
  };
  const toRaw = (time: number) => {
    let removed = 0;
    for (const range of rawIdle) {
      const projectedDuration = (range.end - range.start) * scale(range);
      const compactStart = range.start - removed;
      const compactEnd = compactStart + projectedDuration;
      if (time >= compactEnd) { removed += range.end - range.start - projectedDuration; continue; }
      if (time > compactStart) return range.start + (time - compactStart) / scale(range);
      break;
    }
    return time + removed;
  };
  const projectedManifest: Manifest = {
    ...manifest,
    raw_duration_ms: toPlayback(playbackEnd),
    segments: manifest.segments.map((segment) => ({ ...segment, clock_offset_ms: toPlayback(segment.clock_offset_ms) })),
    tab_events: manifest.tab_events?.map((event) => ({ ...event, t_ms: toPlayback(event.t_ms) })),
    navigation_events: navigationEvents.map((event) => ({
      ...event,
      started_at_ms: toPlayback(event.started_at_ms),
      committed_at_ms: toPlayback(event.committed_at_ms),
      ready_at_ms: toPlayback(event.ready_at_ms),
    })),
    markers: manifest.markers.map((marker) => ({ ...marker, t_ms: toPlayback(marker.t_ms) })),
  };
  const projectedEvents = new Map(projectedManifest.segments.map((segment) => {
    const source = eventSets.get(segment.id) ?? [];
    const originalSegment = manifest.segments.find((item) => item.id === segment.id)!;
    const started = source[0]?.timestamp ?? 0;
    const events = source.map((event) => ({ ...event, timestamp: started + toPlayback(originalSegment.clock_offset_ms + event.timestamp - started) - segment.clock_offset_ms }));
    return [segment.id, events] as const;
  }));
  const projectedIdle = rawIdle.map((range) => ({ start: toPlayback(range.start), end: toPlayback(range.end), originalDuration: range.end - range.start, mode: idleMode, speed: defaults.idle_fast_forward_speed }));
  return {
    manifest: projectedManifest,
    eventSets: projectedEvents,
    duration: toPlayback(playbackEnd),
    activities: activities.map(toPlayback),
    playbackEnd: toPlayback(playbackEnd),
    idleRanges: projectedIdle,
    toPlayback,
    toRaw,
  };
}

function idleScale(range: IdleRange, mode: IdleMode, defaults: ReplayDefaults) {
  const duration = range.end - range.start;
  if (mode === "preserve") return 1;
  if (mode === "fast_forward") return 1 / defaults.idle_fast_forward_speed;
  return Math.min(1, defaults.idle_retained_ms / duration);
}

function resolvedReplayDefaults(value: ReplayDefaults | undefined): ReplayDefaults {
  if (!value || !["cut", "fast_forward", "preserve"].includes(value.idle_mode)) return DEFAULT_REPLAY_DEFAULTS;
  if (![value.idle_retained_ms, value.idle_fast_forward_speed, value.default_speed].every((item) => Number.isFinite(item) && item > 0)) return DEFAULT_REPLAY_DEFAULTS;
  return value;
}

function prepareTimeline(markers: Marker[], navigationEvents: NavigationEvent[], duration: number, interactions: number[], playbackEnd: number, projectedIdle: TimelineIdleRange[]) {
  // Markers split the baseline into chapters, YouTube-style: the gaps make
  // the journey's structure legible before anything is hovered.
  const boundaries = [...new Set([0, ...markers.map((marker) => marker.t_ms).filter((time) => time > 0 && time < duration), duration])].sort((left, right) => left - right);
  document.querySelector<HTMLElement>("#chapter-track")!.innerHTML = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    return `<i style="left:${clamp(start / duration * 100, 0, 100)}%;width:max(2px, calc(${clamp((end - start) / duration * 100, 0, 100)}% - 3px))"></i>`;
  }).join("");
  const density = document.querySelector<HTMLElement>("#density")!;
  const buckets = Array.from({ length: 72 }, () => 0);
  interactions.forEach((time) => { buckets[Math.min(buckets.length - 1, Math.floor(time / duration * buckets.length))] += 1; });
  const max = Math.max(1, ...buckets);
  density.innerHTML = buckets.map((count) => `<i data-timeline-tooltip="Recorded activity — ${count ? `${count} event${count === 1 ? "" : "s"}` : "no events"}" style="--level:${Math.max(.08, count / max)}"></i>`).join("");
  document.querySelector<HTMLElement>("#idle-ranges")!.innerHTML = projectedIdle.map((range) => {
    const label = range.mode === "fast_forward"
      ? `Idle time — played at ${range.speed}× (${formatDuration(range.originalDuration)} recorded)`
      : nearlyEqual(range.originalDuration, range.end - range.start)
        ? `Idle time — ${formatDuration(range.originalDuration)} retained`
        : `Idle time — reduced from ${formatDuration(range.originalDuration)} to ${formatDuration(range.end - range.start)}`;
    return `<i data-idle-range data-timeline-start="${range.start}" data-timeline-end="${range.end}" data-timeline-tooltip="${escape(label)}" style="left:${clamp(range.start / duration * 100, 0, 100)}%;width:${clamp((range.end - range.start) / duration * 100, 0, 100)}%"></i>`;
  }).join("");
  document.querySelector<HTMLElement>("#navigation-events")!.innerHTML = navigationEvents.map((event) => {
    const start = clamp(event.started_at_ms / duration * 100, 0, 100);
    const presentationEnd = Math.min(duration, event.ready_at_ms + RELOAD_CONTEXT_MS);
    const end = clamp(presentationEnd / duration * 100, start, 100);
    const action = event.kind === "reload" ? "Page refreshed" : "Page navigated";
    const exactDuration = Math.max(0, event.ready_at_ms - event.started_at_ms);
    const label = `${action} — ${formatDuration(exactDuration)} transition`;
    return `<i data-navigation-event data-timeline-start="${event.started_at_ms}" data-timeline-end="${presentationEnd}" data-timeline-tooltip="${escape(label)}" style="left:${start}%;width:${Math.max(.45, end - start)}%"></i>`;
  }).join("");
  const removed = projectedIdle.reduce((total, range) => total + Math.max(0, range.originalDuration - (range.end - range.start)), 0);
  document.querySelector<HTMLElement>("#idle-summary")!.textContent = projectedIdle.length
    ? `${projectedIdle.length} gap${projectedIdle.length === 1 ? "" : "s"}${removed >= 1_000 ? ` · ${formatDuration(removed)} ${projectedIdle[0]!.mode === "fast_forward" ? "compressed" : "skipped"}` : ""}`
    : "No idle gaps";
  document.querySelector<HTMLElement>("#timeline-markers")!.innerHTML = markers.map((marker, index) => `<button data-marker="${marker.t_ms}" data-marker-index="${index}"${marker.color ? ` data-marker-color="${marker.color}"` : ""} data-timeline-tooltip="${escape(marker.label)}" aria-label="Jump to marker: ${escape(marker.label)}" aria-current="false" style="left:${clamp(marker.t_ms / duration * 100, 1, 99)}%"><span class="marker-dot"></span></button>`).join("");
}

function updateActiveMarker(time: number) {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-marker], [data-chapter]"));
  const times = buttons.map((button) => Number(button.dataset.marker ?? button.dataset.chapter));
  const active = [...new Set(times)].sort((left, right) => left - right).filter((value) => value <= time + 450).at(-1);
  buttons.forEach((button, index) => {
    const selected = times[index] === active;
    if (selected && button.dataset.chapter !== undefined && !button.classList.contains("is-active")) button.scrollIntoView({ block: "nearest" });
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-current", selected ? "step" : "false");
  });
}

function sessionMetaMarkup(manifest: Manifest) {
  const items: string[] = [];
  // Recordings are a general-purpose capture of any flow, not just bug repros,
  // so the card carries no outcome tag — only neutral context (date, length).
  const created = manifest.created_at ? formatDate(manifest.created_at) : "";
  if (created) items.push(`<span>${escape(created)}</span>`);
  items.push(`<span>${format(manifest.raw_duration_ms)}</span>`);
  return `<div class="session-meta">${items.join("")}</div>`;
}
function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function wireSessionCards() {
  const play = () => document.querySelector<HTMLButtonElement>("#play")?.click();
  const intro = document.querySelector<HTMLElement>("#intro-card");
  if (intro) intro.onclick = play;
  const again = document.querySelector<HTMLButtonElement>("#watch-again");
  if (again) again.onclick = play;
}
function dismissIntro() {
  if (introDismissed) return;
  introDismissed = true;
  document.querySelector("#intro-card")?.classList.remove("is-visible");
}
function setEndCard(visible: boolean) {
  document.querySelector("#end-card")?.classList.toggle("is-visible", visible);
}
function wireDeckMenus() {
  document.querySelectorAll<HTMLElement>(".deck-menu").forEach((menu) => {
    const button = menu.querySelector<HTMLButtonElement>(".menu-button");
    const pop = menu.querySelector<HTMLElement>(".menu-pop");
    if (!button || !pop) return;
    button.onclick = () => {
      const willOpen = pop.hidden;
      closeDeckMenus();
      pop.hidden = !willOpen;
      button.setAttribute("aria-expanded", String(willOpen));
    };
  });
}
function closeDeckMenus() {
  document.querySelectorAll<HTMLElement>(".deck-menu .menu-pop:not([hidden])").forEach((pop) => { pop.hidden = true; });
  document.querySelectorAll<HTMLElement>(".deck-menu .menu-button[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false"));
}
function wireChapters() {
  const toggle = document.querySelector<HTMLButtonElement>("#chapters-toggle");
  const panel = document.querySelector<HTMLElement>("#chapters-panel");
  if (!toggle || !panel) return;
  const apply = () => {
    panel.classList.toggle("is-open", chaptersOpen === true);
    toggle.classList.toggle("is-open", chaptersOpen === true);
    toggle.setAttribute("aria-expanded", chaptersOpen === true ? "true" : "false");
  };
  toggle.onclick = () => {
    chaptersOpen = chaptersOpen !== true;
    if (chaptersOpen) closeChat();
    apply();
  };
  apply();
}

function installTimelineTooltips() {
  const timeline = document.querySelector<HTMLElement>(".timeline-wrap");
  const tooltip = document.querySelector<HTMLElement>("#timeline-tooltip");
  if (!timeline || !tooltip) return;
  let timer: number | undefined;
  let pendingLabel = "";
  const hide = () => {
    if (timer) window.clearTimeout(timer);
    timer = undefined;
    pendingLabel = "";
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
  };
  const move = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-timeline-tooltip]") : null;
    const directLabel = target?.dataset.timelineTooltip;
    const bounds = timeline.getBoundingClientRect();
    const time = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const ranged = Array.from(timeline.querySelectorAll<HTMLElement>("[data-navigation-event], [data-idle-range]")).find((element) => {
      const start = Number(element.dataset.timelineStart);
      const end = Number(element.dataset.timelineEnd);
      return time >= start / Number(document.querySelector<HTMLInputElement>("#scrubber")!.max) && time <= end / Number(document.querySelector<HTMLInputElement>("#scrubber")!.max);
    });
    const label = directLabel ?? ranged?.dataset.timelineTooltip ?? timeline.querySelectorAll<HTMLElement>("#density i")[Math.min(71, Math.floor(time * 72))]?.dataset.timelineTooltip;
    if (!label) return hide();
    tooltip.style.left = `${event.clientX}px`;
    tooltip.style.top = `${event.clientY - 12}px`;
    if (label === pendingLabel || (tooltip.classList.contains("is-visible") && tooltip.textContent === label)) return;
    if (timer) window.clearTimeout(timer);
    pendingLabel = label;
    tooltip.classList.remove("is-visible");
    timer = window.setTimeout(() => {
      tooltip.textContent = label;
      tooltip.classList.add("is-visible");
      tooltip.setAttribute("aria-hidden", "false");
      timer = undefined;
    }, TIMELINE_TOOLTIP_DELAY_MS);
  };
  timeline.addEventListener("pointermove", move);
  timeline.addEventListener("pointerleave", hide);
  timeline.addEventListener("pointerdown", hide);
}

function syncNarration(markers: Marker[], time: number, force = false) {
  const marker = [...markers].reverse().find((item) => item.t_ms <= time + 450);
  const key = marker && `${marker.label} ${marker.note ?? ""}`;
  if (!force && key === lastNarrationKey) return;
  lastNarrationKey = key;
  if (marker) setActionCaption(marker.label, marker.note);
  else document.querySelector("#caption")?.classList.remove("is-visible");
}
function sessionDuration(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const eventEnd = Math.max(1, ...manifest.segments.map((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    return segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? 0) - (events[0]?.timestamp ?? 0));
  }));
  return Math.max(manifest.raw_duration_ms ?? 0, eventEnd);
}
function activityTimes(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const interactions = manifest.segments.flatMap((segment) => segmentActivityTimes(eventSets.get(segment.id) ?? [], segment.clock_offset_ms));
  const end = eventEndTime(manifest, eventSets);
  const navigationContext = resolvedNavigationEvents(manifest, eventSets).flatMap((event) => [
    clamp(event.started_at_ms - RELOAD_CONTEXT_MS, 0, end),
    clamp(event.ready_at_ms + RELOAD_CONTEXT_MS, 0, end),
  ]);
  return [...interactions, ...navigationContext];
}
function segmentActivityTimes(events: ReplayEvent[], clockOffsetMs: number) {
  const started = events[0]?.timestamp ?? 0;
  return [clockOffsetMs, ...events.filter(isActivityEvent).map((event) => clockOffsetMs + event.timestamp - started)];
}
function resolvedNavigationEvents(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>): NavigationEvent[] {
  if (manifest.navigation_events?.length) return manifest.navigation_events;
  // Recordings made before first-class navigation capture retain the former
  // meta-event fallback. It is converted once into timeline metadata so the
  // player never reacts to rrweb's seek reconstruction events.
  return manifest.segments.flatMap((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    const firstNavigation = events.find((event) => event.type === 4)?.timestamp;
    return events.filter((event) => event.type === 4 && event.timestamp > (firstNavigation ?? Infinity)).map((event) => {
      const time = segment.clock_offset_ms + event.timestamp - started;
      const href = typeof event.data?.href === "string" ? event.data.href : segment.page_url;
      return { segment_id: segment.id, kind: "reload" as const, started_at_ms: time, committed_at_ms: time, ready_at_ms: time, from_url: href, to_url: href };
    });
  });
}
function eventEndTime(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  return Math.max(0, ...manifest.segments.map((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    return segment.clock_offset_ms + Math.max(0, (events.at(-1)?.timestamp ?? started) - started);
  }));
}
function resolveMarkerTimes(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>) {
  const steps = manifest.segments.flatMap((segment) => {
    const events = eventSets.get(segment.id) ?? [];
    const started = events[0]?.timestamp ?? 0;
    return events.filter((event, index) => isMarkerStep(event, index)).map((event) => segment.clock_offset_ms + event.timestamp - started);
  }).sort((left, right) => left - right);
  return manifest.markers.map((marker) => {
    const related = marker.placement === "before_next"
      ? steps.find((time) => time >= marker.t_ms)
      : [...steps].reverse().find((time) => time <= marker.t_ms);
    return related === undefined ? marker : { ...marker, t_ms: related };
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
function setActionCaption(title: string, copy?: string) {
  const caption = document.querySelector<HTMLElement>("#caption");
  if (!caption) return;
  caption.querySelector("strong")!.textContent = title;
  const detail = caption.querySelector("p")!;
  detail.textContent = copy ?? "";
  detail.hidden = !copy;
  caption.classList.add("is-visible");
  scheduleCaptionFade();
}
// While playing, narration behaves like a lower third and yields the stage
// back after a beat; while paused it stays up for reading.
function scheduleCaptionFade() {
  if (captionTimer) window.clearTimeout(captionTimer);
  captionTimer = undefined;
  if (!isPlayerPlaying()) return;
  captionTimer = window.setTimeout(() => document.querySelector("#caption")?.classList.remove("is-visible"), CAPTION_LINGER_MS);
}
function isPlayerPlaying() { return document.querySelector("#play")?.classList.contains("is-playing") === true; }
// The chrome steps back while the replay is playing and the pointer rests.
let uiIdleTimer: number | undefined;
function wakeInterface() {
  const screen = document.querySelector<HTMLElement>(".replay-screen");
  if (!screen) return;
  screen.classList.remove("is-idle");
  if (uiIdleTimer) window.clearTimeout(uiIdleTimer);
  uiIdleTimer = window.setTimeout(() => {
    if (isPlayerPlaying()) document.querySelector(".replay-screen")?.classList.add("is-idle");
  }, UI_IDLE_MS);
}
function flashPlayState(playing: boolean) {
  const flash = document.querySelector<HTMLElement>("#state-flash");
  if (!flash) return;
  flash.classList.toggle("is-pause", !playing);
  flash.classList.remove("is-animating");
  void flash.offsetWidth;
  flash.classList.add("is-animating");
}
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}
function isActivityEvent(event: ReplayEvent) {
  // Match rrweb's own user-interaction range: mouse movement/clicks, scrolling,
  // viewport changes, and input count as activity; DOM mutation and narration
  // markers do not keep an idle gap alive.
  return event.type === 3 && ((event.data?.source ?? -1) > 1 && (event.data?.source ?? Infinity) <= 5 || event.data?.recSynthetic === "approach");
}
function isMarkerStep(event: ReplayEvent, index: number) {
  // Mouse moves describe travel, not an explanation-worthy step. Buttons,
  // input, navigation, and rebuilt documents are visible state transitions.
  if (event.type === 3) return event.data?.source === 2 || event.data?.source === 5 || event.data?.source === 0;
  return index > 0 && (event.type === 2 || event.type === 4);
}
function humanizeEvents(events: ReplayEvent[]) {
  const output: ReplayEvent[] = [];
  let addedDelay = 0;
  let lastEmittedAt = -Infinity;
  let cursor: { x: number; y: number; t: number } | undefined;
  // rrweb stores an input's full cumulative value on every keystroke. Remember
  // the last value per field so a stream of per-keystroke events can be paced
  // in place instead of re-dramatized from the first character.
  const lastInput = new Map<number, { text: string; nextSlot: number }>();
  for (const event of events) {
    // Playwright's raw move stream often represents instantaneous driver jumps,
    // not a useful human gesture. Reconstruct that gesture from actual targets.
    if (event.type === 3 && event.data?.source === 1) continue;
    const adjusted = { ...event, timestamp: event.timestamp + addedDelay, data: event.data ? { ...event.data } : undefined };
    const pointer = pointerPosition(adjusted);
    // The first pointer position has no visible origin to travel from — the
    // cursor fades in on target instead of flying in from the page corner.
    if (isDirectPointerInteraction(adjusted) && pointer && cursor && adjusted.timestamp - cursor.t >= 280) {
      const approachAt = Math.max(lastEmittedAt + 1, adjusted.timestamp - CURSOR_APPROACH_MS);
      if (approachAt < adjusted.timestamp - 45) {
        // A single endpoint still lets rrweb paint the cursor directly on the
        // target. Give it a short, timed path instead, continuing from the
        // prior target.
        const origin = cursor;
        const steps = 8;
        const positions = Array.from({ length: steps }, (_, index) => {
          const progress = index / (steps - 1);
          const eased = progress < 0.5
            ? 4 * progress ** 3
            : 1 - (-2 * progress + 2) ** 3 / 2;
          return {
            x: origin.x + (pointer.x - origin.x) * eased,
            y: origin.y + (pointer.y - origin.y) * eased,
            id: pointer.id,
            timeOffset: Math.round(progress * CURSOR_APPROACH_MS),
          };
        });
        output.push({ type: 3, timestamp: approachAt, data: { source: 1, recSynthetic: "approach", positions } });
        lastEmittedAt = approachAt;
        cursor = { ...pointer, t: adjusted.timestamp };
      }
    }
    const typedText = typeableFill(adjusted);
    if (typedText !== undefined) {
      const id = adjusted.data!.id;
      const prior = typeof id === "number" ? lastInput.get(id) : undefined;
      // Incremental typing: this event is the previous value plus one or more
      // characters. rrweb already has the right cumulative value, so just pace
      // it onto the keystroke cadence. Splitting from the first character here
      // is what visibly deletes and retypes the field on every keystroke.
      const added = prior && typedText.startsWith(prior.text) ? Array.from(typedText).length - Array.from(prior.text).length : 0;
      if (prior && added > 0) {
        const stepAt = Math.max(adjusted.timestamp, prior.nextSlot);
        addedDelay += Math.max(0, stepAt - adjusted.timestamp);
        output.push({ ...adjusted, timestamp: stepAt });
        lastEmittedAt = stepAt;
        prior.text = typedText;
        prior.nextSlot = stepAt + added * KEYSTROKE_PACE_MS;
        continue;
      }
      if (isVisibleShortFill(adjusted)) {
        // A batch fill (paste or a single insertText) arrives with the whole
        // value at once; dramatize it character by character from an empty field.
        const characters = Array.from(typedText);
        let slot = adjusted.timestamp;
        for (let index = 0; index < characters.length; index += 1) {
          const typed = characters.slice(0, index + 1).join("");
          slot = adjusted.timestamp + (index + 1) * KEYSTROKE_PACE_MS;
          output.push({ ...adjusted, timestamp: slot, data: { ...adjusted.data, text: typed } });
        }
        addedDelay += characters.length * KEYSTROKE_PACE_MS;
        lastEmittedAt = slot;
        if (typeof id === "number") lastInput.set(id, { text: typedText, nextSlot: slot + KEYSTROKE_PACE_MS });
        continue;
      }
      // Lone keystrokes (one or two characters) and checkbox "on" values pass
      // through unchanged, but the value is still remembered so the next
      // keystroke is recognized as incremental.
      output.push(adjusted);
      lastEmittedAt = adjusted.timestamp;
      if (typeof id === "number") lastInput.set(id, { text: typedText, nextSlot: adjusted.timestamp + KEYSTROKE_PACE_MS });
      continue;
    }
    output.push(adjusted);
    lastEmittedAt = adjusted.timestamp;
    if (pointer) cursor = { ...pointer, t: adjusted.timestamp };
  }
  return output;
}
function pointerPosition(event: ReplayEvent) {
  if (event.type !== 3) return undefined;
  if (event.data?.source === 1) return event.data.positions?.at(-1);
  if (event.data?.source === 2 && Number.isFinite(event.data.x) && Number.isFinite(event.data.y)) return { x: event.data.x!, y: event.data.y!, id: event.data.id };
  return undefined;
}
function isDirectPointerInteraction(event: ReplayEvent) {
  return event.type === 3 && event.data?.source === 2 && Number.isFinite(event.data.x) && Number.isFinite(event.data.y);
}
function typeableFill(event: ReplayEvent): string | undefined {
  if (event.type !== 3 || event.data?.source !== 5) return undefined;
  const text = event.data?.text;
  return typeof text === "string" ? text : undefined;
}
function isVisibleShortFill(event: ReplayEvent) {
  const text = event.data?.text;
  return event.type === 3 && event.data?.source === 5 && typeof text === "string" && text.length > 2 && text.length <= 32 && text !== "on";
}
function sessionEventTime(event: unknown, events: ReplayEvent[], tabStart: number) {
  if (!isReplayEvent(event) || !events[0]) return undefined;
  return tabStart + event.timestamp - events[0].timestamp;
}
function isReplayEvent(event: unknown): event is ReplayEvent {
  return typeof event === "object" && event !== null && "timestamp" in event && typeof (event as { timestamp?: unknown }).timestamp === "number";
}
function idleRanges(activities: number[], playbackEnd: number): IdleRange[] {
  const times = [...new Set(activities.filter((time) => time >= 0 && time <= playbackEnd).sort((left, right) => left - right))];
  const ranges: IdleRange[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const start = times[index - 1]!;
    const end = times[index]!;
    if (end - start >= IDLE_THRESHOLD_MS) ranges.push({ start, end });
  }
  const last = times.at(-1);
  if (last !== undefined && playbackEnd - last >= IDLE_THRESHOLD_MS) ranges.push({ start: last, end: playbackEnd });
  return ranges;
}
function nearlyEqual(left: number, right: number) { return Math.abs(left - right) < 2; }
function recordingViewport(events: ReplayEvent[]) {
  const meta = events.find((event) => event.type === 4 && event.data?.width && event.data?.height);
  return { width: meta?.data?.width ?? 1280, height: meta?.data?.height ?? 720 };
}
function revealCursorOnFirstMove(replayer: Replayer, lifetime: AbortController) {
  const mouse = replayer.wrapper.querySelector<HTMLElement>(".replayer-mouse");
  if (!mouse) return;
  // rrweb parks the cursor at the page origin until the first pointer event
  // positions it. Keep it invisible until then.
  const reveal = new MutationObserver(() => {
    replayer.wrapper.classList.add("rec-cursor-live");
    reveal.disconnect();
  });
  reveal.observe(mouse, { attributes: true, attributeFilter: ["style"] });
  lifetime.signal.addEventListener("abort", () => reveal.disconnect(), { once: true });
}
function spawnClickRipple(replayer: Replayer, interaction: { x?: number; y?: number }) {
  const mouse = replayer.wrapper.querySelector<HTMLElement>(".replayer-mouse");
  const x = typeof interaction.x === "number" ? interaction.x : parseFloat(mouse?.style.left ?? "");
  const y = typeof interaction.y === "number" ? interaction.y : parseFloat(mouse?.style.top ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const ripple = document.createElement("span");
  ripple.className = "rec-click-ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  replayer.wrapper.appendChild(ripple);
  window.setTimeout(() => ripple.remove(), 700);
}
function fitReplay(mount: HTMLElement, replayer: Replayer, viewport: { width: number; height: number }) {
  // The camera owns the wrapper transform; fitReplay only sizes the canvas.
  replayer.wrapper.style.width = `${viewport.width}px`;
  replayer.wrapper.style.height = `${viewport.height}px`;
}
function createCamera(mount: HTMLElement, replayer: Replayer, viewport: { width: number; height: number }, lifetime: AbortController) {
  let enabled = cameraZoomEnabled;
  let zoom = 1;
  let targetZoom = 1;
  let focusX = viewport.width / 2;
  let focusY = viewport.height / 2;
  let targetX = focusX;
  let targetY = focusY;
  let holdTimer: number | undefined;
  let frame: number | undefined;
  let lastTick = 0;
  const apply = () => {
    const base = Math.min(mount.clientWidth / viewport.width, mount.clientHeight / viewport.height);
    // transform-origin is the wrapper center: translating by (center - focus)
    // in content pixels before scaling lands the focus point mid-stage.
    replayer.wrapper.style.transform = `scale(${base * zoom}) translate(${viewport.width / 2 - focusX}px, ${viewport.height / 2 - focusY}px)`;
  };
  const schedule = () => {
    if (frame !== undefined || lifetime.signal.aborted) return;
    lastTick = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    frame = undefined;
    const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
    lastTick = now;
    const blend = 1 - Math.exp(-CAMERA_EASE_PER_S * dt);
    zoom += (targetZoom - zoom) * blend;
    focusX += (targetX - focusX) * blend;
    focusY += (targetY - focusY) * blend;
    // Hard clamp at the in-flight zoom so the frame never pans past an edge.
    const halfW = viewport.width / (2 * zoom);
    const halfH = viewport.height / (2 * zoom);
    focusX = clamp(focusX, halfW, viewport.width - halfW);
    focusY = clamp(focusY, halfH, viewport.height - halfH);
    apply();
    if (Math.abs(zoom - targetZoom) > 0.001 || Math.abs(focusX - targetX) > 0.5 || Math.abs(focusY - targetY) > 0.5) schedule();
  };
  const setFocusTarget = (x: number, y: number) => {
    const halfW = viewport.width / (2 * targetZoom);
    const halfH = viewport.height / (2 * targetZoom);
    targetX = clamp(x, halfW, viewport.width - halfW);
    targetY = clamp(y, halfH, viewport.height - halfH);
  };
  const zoomOut = () => {
    targetZoom = 1;
    setFocusTarget(viewport.width / 2, viewport.height / 2);
    schedule();
  };
  const armHold = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(zoomOut, CAMERA_HOLD_MS);
  };
  const noteInteraction = (x: number, y: number) => {
    if (!enabled) return;
    targetZoom = CAMERA_ZOOM;
    setFocusTarget(x, y);
    armHold();
    schedule();
  };
  const trackCursor = (x: number, y: number) => {
    if (!enabled || targetZoom === 1) return;
    setFocusTarget(x, y);
    schedule();
  };
  const refreshHold = () => {
    if (!enabled || targetZoom === 1) return;
    armHold();
  };
  const reset = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = undefined;
    zoomOut();
  };
  const setPlaying = (value: boolean) => {
    // The hold window is wall-clock; freeze it while paused so a paused
    // inspection stays framed, and rearm it on resume.
    if (!value) { if (holdTimer) window.clearTimeout(holdTimer); holdTimer = undefined; }
    else if (targetZoom > 1) armHold();
  };
  const setEnabled = (value: boolean) => {
    enabled = value;
    if (!value) reset();
  };
  lifetime.signal.addEventListener("abort", () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (holdTimer) window.clearTimeout(holdTimer);
  }, { once: true });
  apply();
  return { apply, noteInteraction, trackCursor, refreshHold, reset, setPlaying, setEnabled };
}
function isTextEntryTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; type?: string };
  if (element.isContentEditable || ["TEXTAREA", "SELECT"].includes(element.tagName ?? "")) return true;
  if (element.tagName !== "INPUT") return false;
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes((element.type ?? "text").toLowerCase());
}
// A target lives in the player's own chrome only when it belongs to the top
// document; anything inside the replay iframe reports a different ownerDocument.
function isMainDocumentTarget(target: EventTarget | null) {
  return !!target && target instanceof Node && target.ownerDocument === document;
}
type ElementLike = { nodeType: number; classList: DOMTokenList; getAttribute(name: string): string | null; textContent: string | null; tagName: string };
function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }
/** Let rrweb finish painting a fresh seek before the assistant reads the frame. */
function settleReplayFrame() {
  return new Promise<void>((resolveSettle) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolveSettle, 120)));
  });
}
/** Deepest visible element whose text contains the query (case-insensitive). */
function findElementByText(frameDocument: Document, query: string) {
  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return null;
  let best: Element | null = null;
  let bestLength = Infinity;
  for (const element of Array.from(frameDocument.body?.querySelectorAll("*") ?? [])) {
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) continue;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text.toLowerCase().includes(needle)) continue;
    if (element.getClientRects().length === 0) continue;
    if (text.length < bestLength) { best = element; bestLength = text.length; }
  }
  return best;
}
async function request<T>(url: string, init?: RequestInit) { const response = await fetch(url, init); if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error); return response.json() as Promise<T>; }
function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function formatDuration(ms: number) { return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
