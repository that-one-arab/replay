import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";
import { closeChat, initChat, registerReplayControl, syncChatTimes, wireChatToggle } from "./chat.js";
import { dismissOnboarding, startOnboardingIfDue } from "./onboarding.js";
import { EventType, IncrementalSource, MouseInteraction, type AgentAction, type Defect, type IdleMode, type Manifest, type Marker, type NavigationEvent, type ReplayDefaults, type ReplayEvent, type Segment, type TabEvent, type TimelineIdleRange } from "./types.js";
import { clamp, escape, format, formatDuration, formatSaved, nearlyEqual } from "./format.js";
import { CURSOR_APPROACH_MS, humanizeEvents, isRealPoint, withCursorLeadIns } from "./humanize.js";
import { RELOAD_CONTEXT_MS, closedAt, describeAction, nextFocusForSegment, replayViewport, resolveMarkerTimes, segmentAtTime, segmentLabel, sessionEventTime, tabEvents } from "./manifest.js";
import { DEFAULT_PLAYBACK_SPEED, projectPlayback, resolvedReplayDefaults, totalIdleMs } from "./projection.js";
import { createCamera } from "./camera.js";
import { elementCenter, isElementLike, makeCursorPlacer, revealCursorOnFirstMove, spawnClickRipple, type ElementLike } from "./cursor.js";
import { sanitizeReplayEvents } from "./sanitize.js";
import { renderUploadDialog } from "./upload.js";

const TAB_FOCUS_DELAY_MS = 700;
const REFRESH_INDICATOR_MS = 1_100;
const MIN_REFRESH_INDICATOR_MS = 160;
const MAX_REFRESH_INDICATOR_MS = 1_500;
const TIMELINE_TOOLTIP_DELAY_MS = 550;
const CAPTION_LINGER_MS = 4_500;
// A `beat` defect eases playback into a slow dwell (see HOLD_DWELL_SPEED)
// rather than freezing the frame, so the viewer keeps agency while the
// Expected/Actual callout has time to land. The dwell lasts this much wall-clock.
const HOLD_BEAT_MS = 3_200;
// Crawl speed during a beat dwell: slow enough to read the defect, fast enough
// that the player never reads as frozen. `until_ack` is the mode for a true stop.
const HOLD_DWELL_SPEED = 0.35;
const UI_IDLE_MS = 3_200;
const SEEK_STEP_MS = 5_000;
// Arrow-key marker navigation buffers. Going back, treat any marker within this
// distance at or behind the playhead as the one we're "on" and skip it, so a
// playhead that has drifted just past a marker still steps to the genuinely
// previous one instead of snapping back onto it. Going forward only skips the
// marker we're sitting on so an upcoming marker stays reachable.
const MARKER_BACK_BUFFER_MS = 600;
const MARKER_FWD_SLOP_MS = 60;
// Camera inputs arriving from rrweb's seek reconstruction are historical; only
// events cast near the live playhead may steer the camera.
const CAMERA_SYNC_WINDOW_MS = 800;
// A replay fetch that hasn't answered in this long means the server is gone,
// not slow — fail with a clear message rather than hanging forever. Sharing
// uploads to the remote server, so it gets a longer leash.
const REQUEST_TIMEOUT_MS = 30_000;
const SHARE_TIMEOUT_MS = 120_000;

// Control-bar icons. Share/Copy/Download are icon-only buttons, so the glyph is
// the whole label — the accessible name lives on aria-label/title instead.
const ICON_SHARE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

const app = document.querySelector<HTMLDivElement>("#app")!;
const id = new URLSearchParams(location.search).get("id");
let activePlayback: AbortController | undefined;
let currentSessionTime = 0;
let lastNarrationKey: string | undefined;
let captionTimer: number | undefined;
// The active-marker highlight (ring + defect overlay) is driven by syncNarration,
// but it needs the live replayer/camera — so each replay() pass installs a
// driver here. Undefined until the first pass and after teardown.
let highlightDriver: ((marker: Marker | undefined) => void) | undefined;
let chaptersOpen: boolean | undefined;
let introDismissed = false;
// The spotlight tour starts once after the first replay shell renders and is
// never re-triggered by the recursive present() calls that seeks/idle changes fire.
let tourStarted = false;
// The auto-zoom camera is a viewer setting: off by default, toggled from the
// play-bar settings menu, and remembered across replays via replay-camera. The
// ?camera=on/off query param still seeds it for shared links.
let cameraZoomEnabled = resolveCameraPreference();

function resolveCameraPreference() {
  const requested = new URLSearchParams(location.search).get("camera");
  try {
    if (requested === "on" || requested === "1") { localStorage.setItem("replay-camera", "on"); return true; }
    if (requested === "off" || requested === "0") { localStorage.setItem("replay-camera", "off"); return false; }
    return localStorage.getItem("replay-camera") === "on";
  } catch { return requested === "on" || requested === "1"; }
}
let shareAvailable = false;
// On the hosted share server the viewer is already on the public link, so the
// control bar offers Copy (of this page's URL) instead of Share (which uploads).
let hosted = false;
let shareUrl: string | undefined;
// The chat panel and its tools speak raw replay time; the active playback
// projection translates it. Refreshed by every present().
let rawToPlayback: (time: number) => number = (time) => time;
let playbackToRaw: (time: number) => number = (time) => time;
if (!id) void bootstrapWithoutReplay();
else {
  maintainReplayLease();
  void load(id);
}

// Opening the player with no replay selected. On the hosted share server the
// bare origin (share.replaythis.io) is a destination people paste a `.replay`
// into, so offer an upload dialog there; locally it just means the CLI was not
// given an id, so keep the existing hint.
async function bootstrapWithoutReplay() {
  const environment = await detectEnvironment();
  hosted = environment.hosted;
  if (hosted) renderUploadDialog();
  else renderError("Choose a replay with `replay open <id>`.");
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
    body: JSON.stringify({ owner: "replay-player", kind: "replay", ttl_ms: 30_000 }),
  }).then(async (response) => {
    if (!response.ok) return;
    const value = await response.json() as { lease_id?: string };
    if (!value.lease_id) return;
    leaseId = value.lease_id;
    renewTimer = window.setInterval(renew, 10_000);
  }).catch(() => undefined);
  window.addEventListener("pagehide", release, { once: true });
}

async function load(replayId: string) {
  try {
    currentSessionTime = 0;
    lastNarrationKey = undefined;
    introDismissed = false;
    shareUrl = undefined;
    // Fetching the manifest and events crosses the network — over the remote
    // share server that can be a real wait. Show a loading state so a shared
    // link never opens to a blank screen while the data streams in.
    renderLoading();
    const environment = await detectEnvironment();
    shareAvailable = environment.shareAvailable;
    hosted = environment.hosted;
    void initChat(replayId, () => {
      // The assistant and the chapters list share the right edge; opening one
      // yields it to the other.
      const chapters = document.querySelector<HTMLButtonElement>("#chapters-toggle");
      if (chapters?.classList.contains("is-open")) chapters.click();
    });
    const manifest = await request<Manifest>(`/api/sessions/${encodeURIComponent(replayId)}/manifest`);
    const eventSets = new Map(await Promise.all(manifest.segments.map(async (segment) => [
      segment.id,
      humanizeEvents(sanitizeReplayEvents(await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segment.id)}`))),
    ] as const)));
    const resolvedManifest = { ...manifest, markers: resolveMarkerTimes(manifest, eventSets) };
    const replayDefaults = resolvedReplayDefaults(manifest.replay_defaults);
    let idleMode = replayDefaults.idle_mode;
    let playbackSpeed = replayDefaults.default_speed;
    const present = async (rawTime = 0, autoplay = false) => {
      const projection = projectPlayback(resolvedManifest, eventSets, idleMode, replayDefaults);
      // originalDuration is mode-independent, so this stays constant across idle
      // re-renders — it's the dead time captured, not how the player paces it.
      const idleSavedMs = totalIdleMs(projection.idleRanges);
      rawToPlayback = projection.toPlayback;
      playbackToRaw = projection.toRaw;
      activePlayback?.abort();
      renderShell(projection.manifest, idleMode, replayDefaults, playbackSpeed, idleSavedMs);
      prepareTimeline(projection.manifest.markers, actionsById(projection.manifest), projection.manifest.navigation_events ?? [], projection.duration, projection.activities, projection.playbackEnd, projection.idleRanges);
      installTimelineTooltips();
      wireShareControl(resolvedManifest.id);
      wireChatToggle(document.querySelector<HTMLButtonElement>("#chat-toggle"));
      wireChapters();
      wireSessionCards();
      wireDeckMenus();
      const session: ReplaySession = {
        manifest: projection.manifest,
        eventSets: projection.eventSets,
        duration: projection.duration,
        onIdleModeChange: (nextMode, requestedTime, shouldAutoplay) => {
          idleMode = nextMode;
          // Re-project after the rebuild registers the new-mode control, so any
          // times already in the chat re-label onto the mode the viewer just picked.
          void present(projection.toRaw(requestedTime), shouldAutoplay).then(syncChatTimes).catch(renderError);
        },
        onPlaybackSpeedChange: (nextSpeed) => { playbackSpeed = nextSpeed; },
      };
      await replay(session, projection.manifest.segments[0], projection.toPlayback(rawTime), autoplay, playbackSpeed);
    };
    await present();
    if (!tourStarted) {
      // The shell and its control-deck targets now exist, so the spotlight tour
      // (if due) can locate #replay, #play, the timeline, Ask AI, and Chapters.
      tourStarted = true;
      startOnboardingIfDue();
    }
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest, idleMode: IdleMode, defaults: ReplayDefaults, playbackSpeed: number, idleSavedMs: number) {
  // Reflect the loaded replay's real title in the browser tab instead of the
  // static placeholder shipped in index.html.
  document.title = manifest.title;
  chaptersOpen ??= manifest.markers.length > 1 && window.matchMedia("(min-width: 1100px)").matches;
  const segmentPicker = manifest.segments.length > 1
    ? `<nav class="segment-picker" aria-label="Captured browser tabs">${manifest.segments.map((segment, index) => `<div class="segment-tab" data-segment="${escape(segment.id)}" title="Opened at ${format(segment.clock_offset_ms)} — ${escape(segment.page_url)}"${index === 0 ? "" : " hidden"}><span>Tab ${index + 1}</span>${escape(segmentLabel(segment.page_url))}</div>`).join("")}</nav>`
    : "";
  // The tuned default pace is the replay's "natural" speed — present it as
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
  const cameraSection = `<span class="menu-label">Camera</span><div class="menu-options">${([["on", "On"], ["off", "Off"]] as const).map(([mode, label]) => `<button data-camera-mode="${mode}"${(mode === "on") === cameraZoomEnabled ? " class=\"selected\"" : ""}>${label}</button>`).join("")}</div>`;
  const settingsMenu = `<div class="deck-menu" id="settings-menu"><button class="menu-button menu-button-icon" id="settings-button" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Replay settings"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button><div class="menu-pop" hidden><span class="menu-label">Idle time</span><div class="menu-options">${idleControls}</div><span class="menu-note" id="idle-summary"></span>${cameraSection}</div></div>`;
  // Local daemon → Share (uploads and copies the new link). Hosted share server
  // → Copy (this page's URL is already the share link). Otherwise nothing.
  const shareControl = shareAvailable
    ? `<div class="share-control" id="share-control"><button class="share-button share-button-icon" id="share" type="button" aria-label="Share replay" title="Share this replay">${ICON_SHARE}</button></div>`
    : hosted
      ? `<div class="share-control" id="copy-control"><button class="share-button share-button-icon" id="copy-link" type="button" aria-label="Copy replay link" title="Copy replay link">${ICON_COPY}</button></div>`
      : "";
  // Both the local daemon and the hosted share server can hand back the portable
  // `.replay` for this session, so a plain download link works everywhere the
  // player is served — no upload, no round-trip. It is a bare anchor so the
  // browser handles the streamed attachment natively.
  const downloadControl = `<a class="share-button share-button-secondary share-button-icon" id="download" href="${escape(`/api/sessions/${encodeURIComponent(manifest.id)}/bundle`)}" download="${escape(`${manifest.title || "replay"}.replay`)}" aria-label="Download replay" title="Download this replay as a portable .replay file">${ICON_DOWNLOAD}</a>`;
  const chatToggle = `<button class="chat-toggle" id="chat-toggle" type="button" hidden aria-expanded="false" title="Ask the replay assistant"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2l2.1 6.2a2 2 0 0 0 1.3 1.3L21.5 12l-6.1 2.5a2 2 0 0 0-1.3 1.3L12 22l-2.1-6.2a2 2 0 0 0-1.3-1.3L2.5 12l6.1-2.5a2 2 0 0 0 1.3-1.3z"/></svg>Ask AI</button>`;
  const chaptersToggle = manifest.markers.length
    ? `<button class="chapters-toggle" id="chapters-toggle" type="button" aria-controls="chapters-panel" aria-expanded="false">Chapters<b>${manifest.markers.length}</b></button>`
    : "";
  const sessionMeta = sessionMetaMarkup(manifest);
  // Only claim a saving when idle is actually elided: "Keep" (preserve) plays
  // every dead second in full, so the line would be false there. The number is
  // the recording's idle sum, so it never depends on the pacing mode.
  const savedLine = idleMode !== "preserve" && idleSavedMs >= 1_000
    ? `<div class="session-saved"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"></path></svg><span><b>${formatSaved(idleSavedMs)}</b> of waiting, skipped</span></div>`
    : "";
  const introCard = introDismissed
    ? ""
    : `<div class="session-overlay is-visible" id="intro-card"><div class="session-card"><span class="session-kicker"><i></i>Replay</span><h1>${escape(manifest.title)}</h1>${sessionMeta}<p class="session-hint">Press play — or space — to watch the captured journey</p></div></div>`;
  // The note is clamped to a few lines so the end-card stays calm, but a full
  // repro can run much longer. The toggle is emitted hidden and only revealed
  // after mount if the text actually overflows the clamp (measured in
  // wireSessionCards), so short notes never grow a dangling "Show more".
  const notesBlock = manifest.notes
    ? `<div class="session-notes-wrap"><p class="session-notes" id="session-notes">${escape(manifest.notes)}</p><button class="notes-toggle" id="notes-toggle" type="button" hidden aria-expanded="false" aria-controls="session-notes">Show more</button></div>`
    : "";
  const endCard = `<div class="session-overlay" id="end-card"><div class="session-card"><span class="session-kicker"><i></i>Replay complete</span><h1>${escape(manifest.title)}</h1>${sessionMeta}${savedLine}${notesBlock}<div class="session-actions"><button class="watch-again" id="watch-again" type="button">Watch again</button><button class="ask-ai" id="ask-ai" type="button" hidden>Ask AI about this replay</button></div></div></div>`;
  const chaptersPanel = manifest.markers.length
    ? `<aside class="chapters-panel" id="chapters-panel" aria-label="Replay chapters"><header>Chapters<span>${manifest.markers.length}</span><button class="chapters-collapse" id="chapters-collapse" type="button" aria-label="Collapse chapters" title="Collapse chapters"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></header><ol>${manifest.markers.map((marker) => {
      const action = marker.action_id ? actionsById(manifest).get(marker.action_id) : undefined;
      const defect = marker.defect ? `<p class="chapter-defect"><span class="defect-row"><b>Expected</b>${escape(marker.defect.expected)}</span><span class="defect-row"><b>Actual</b>${escape(marker.defect.actual)}</span></p>` : "";
      return `<li><button type="button" data-chapter="${marker.t_ms}"${marker.color ? ` data-chapter-color="${marker.color}"` : ""}${marker.node_id != null ? ` data-chapter-highlight` : ""} aria-current="false"><b>${format(marker.t_ms)}</b><span><strong>${escape(marker.label)}</strong>${marker.note ? `<p>${escape(marker.note)}</p>` : ""}${defect}${action ? `<code>${escape(describeAction(action))}</code>` : ""}</span></button></li>`;
    }).join("")}</ol></aside>`
    : "";
  app.innerHTML = `<main class="replay-screen" aria-label="${escape(manifest.title)}"><div id="replay" aria-label="Browser session replay"></div><div class="video-shade"></div><div class="state-flash" id="state-flash" aria-hidden="true"><span></span></div><b id="stage-status" class="sr-only" role="status">Paused</b>${segmentPicker}<div class="address-bar" id="address-bar" role="text" aria-label="Current page address" title="">${escape(manifest.segments[0]?.page_url ?? "")}</div><div class="refresh-indicator" id="refresh-indicator" role="status" aria-live="polite"><span class="refresh-spinner" aria-hidden="true"></span><strong id="refresh-label">Page is refreshing</strong></div><div class="caption-card" id="caption" aria-live="polite"><strong></strong><p hidden></p></div><button class="hold-continue" id="hold-continue" type="button" aria-label="Continue replay">Continue ▸</button>${introCard}${endCard}<section class="control-deck" aria-label="Browser replay controls"><div class="deck-island"><div class="timeline-wrap"><div class="timeline-chapters" id="chapter-track" aria-hidden="true"></div><div class="timeline-idle" id="idle-ranges" aria-label="Idle periods"></div><div class="timeline-navigations" id="navigation-events" aria-label="Page navigations"></div><div class="timeline-density" id="density"></div><div class="timeline-progress" id="timeline-progress"></div><div class="timeline-playhead" id="timeline-playhead" aria-hidden="true"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Browser session timeline" /></div><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div>${speedMenu}${settingsMenu}${downloadControl}${shareControl}${chatToggle}${chaptersToggle}</div></div></section>${chaptersPanel}<div class="timeline-tooltip" id="timeline-tooltip" role="tooltip" aria-hidden="true"></div></main>`;
}

// One health probe tells the player both whether it can upload a share (local
// daemon with REPLAY_SHARE_URL) and whether it is itself running on the hosted
// share server (where the current URL is already the share link).
async function detectEnvironment() {
  try {
    const health = await request<{ share_available?: boolean; hosted?: boolean }>("/health");
    return { shareAvailable: health.share_available === true, hosted: health.hosted === true };
  } catch { return { shareAvailable: false, hosted: false }; }
}

function wireShareControl(replayId: string) {
  const button = document.querySelector<HTMLButtonElement>("#share");
  if (button) button.onclick = () => void shareReplay(replayId, button);
  const copy = document.querySelector<HTMLButtonElement>("#share-copy");
  if (copy) copy.onclick = () => copyShareLink(copy);
  const copyLink = document.querySelector<HTMLButtonElement>("#copy-link");
  if (copyLink) copyLink.onclick = () => copyCurrentUrl(copyLink);
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

// On the hosted share server this page's URL is the share link, so Copy just
// puts the address bar's URL on the clipboard — no upload, no round-trip.
function copyCurrentUrl(button: HTMLButtonElement) {
  const clipboard = navigator.clipboard;
  if (!clipboard) { setActionCaption("Copy the link", "Copy this page's URL from your browser's address bar."); return; }
  void clipboard.writeText(window.location.href)
    .then(() => {
      button.innerHTML = ICON_CHECK;
      window.setTimeout(() => { button.innerHTML = ICON_COPY; }, 1600);
      setActionCaption("Link copied", "This replay's URL is on your clipboard.");
    })
    .catch(() => setActionCaption("Copy the link", "Copy this page's URL from your browser's address bar."));
}

async function shareReplay(replayId: string, button: HTMLButtonElement) {
  // The share link is a means to an end, not something to read — swap the button
  // for a brief spinner, then drop the link straight on the clipboard and confirm
  // with a caption rather than showing the URL.
  button.disabled = true;
  button.innerHTML = `<span class="share-spinner" aria-hidden="true"></span>`;
  try {
    const result = await request<{ shareUrl: string }>(`/api/sessions/${encodeURIComponent(replayId)}/share`, { method: "POST" }, SHARE_TIMEOUT_MS);
    shareUrl = result.shareUrl;
    try {
      await navigator.clipboard.writeText(shareUrl);
      button.innerHTML = ICON_SHARE;
      button.disabled = false;
      setActionCaption("Link copied", "The share link is on your clipboard.");
    } catch {
      // Clipboard blocked (e.g. the browser dropped the click's user activation
      // across the network wait) — degrade to a copyable link so it isn't lost.
      const control = document.querySelector<HTMLElement>("#share-control");
      if (control) control.innerHTML = shareResultMarkup(shareUrl);
      wireShareControl(replayId);
      setActionCaption("Share link ready", "Copy it from the control bar.");
    }
  } catch (error) {
    button.disabled = false;
    button.innerHTML = ICON_SHARE;
    setActionCaption("Share failed", error instanceof Error ? error.message : String(error));
  }
}

function shareResultMarkup(url: string) {
  return `<a class="share-link" href="${escape(url)}" target="_blank" rel="noopener" title="${escape(url)}">${escape(url)}</a><button class="share-button" id="share-copy" type="button">Copy</button>`;
}

// One replay() invocation owns one rrweb Replayer over one segment; seeks, tab
// switches, and idle-mode changes tear it down and start a fresh one. The
// session carries everything that survives those restarts.
type ReplaySession = {
  manifest: Manifest;
  eventSets: Map<string, ReplayEvent[]>;
  duration: number;
  onIdleModeChange?: (mode: IdleMode, requestedTime: number, autoplay: boolean) => void;
  onPlaybackSpeedChange?: (speed: number) => void;
};

async function replay(session: ReplaySession, segment: Segment | undefined, requestedSessionTime: number, autoplay = false, playbackSpeed = DEFAULT_PLAYBACK_SPEED) {
  const { manifest, eventSets, duration, onIdleModeChange, onPlaybackSpeedChange } = session;
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
  const viewport = replayViewport(events);
  let selectedPlaybackSpeed = playbackSpeed;
  let replayDocumentKeyboardHandler: ((event: KeyboardEvent) => void) | undefined;
  // Agent-driven replays capture interactions without pointer coordinates, so
  // rrweb has nothing to move the cursor with. When a replay carries no real
  // pointer data at all, drive the cursor ourselves from the element each
  // interaction resolves to, and feed the replayer lead-in cues so the cursor
  // arrives as the action fires. Replays with real coordinates keep rrweb's.
  const syntheticCursor = !events.some((event) => event.type === EventType.IncrementalSnapshot && (
    (event.data?.source === IncrementalSource.MouseMove && (event.data.positions?.length ?? 0) > 0) ||
    (event.data?.source === IncrementalSource.MouseInteraction && isRealPoint(event.data.x, event.data.y))
  ));
  const replayEvents = syntheticCursor ? withCursorLeadIns(events) : events;
  const replayer = new Replayer(replayEvents as never[], {
    // rrweb only skips when a later mouse/input event exists. Replay owns this
    // policy so navigation, reload, and verification waits are accelerated too.
    root: mount, skipInactive: false, showWarning: false, speed: selectedPlaybackSpeed,
    mouseTail: false,
    // The replay is passive playback. Letting rrweb move real DOM focus into a
    // captured field makes that field typeable and steals focus from the chat
    // composer, so keep focus in the player's own chrome and paint the focus
    // ring ourselves (see the mouse-interaction handler below).
    triggerFocus: false,
    plugins: [{
      onBuild(node: Node) {
        if (node.nodeType !== Node.DOCUMENT_NODE) return;
        node.addEventListener("keydown", (event) => replayDocumentKeyboardHandler?.(event as KeyboardEvent), true);
      },
    }] as never[],
    insertStyleRules: [
      ".replay-focus-target{outline:2px solid rgba(105,86,255,.9)!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(105,86,255,.16)!important;border-radius:4px!important}",
      // Injected into the replay iframe (style.css can't reach in-document nodes),
      // so the highlight ring renders on the captured element itself.
      ".replay-highlight{outline:2px solid #b7abff!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(183,171,255,.22),0 6px 22px rgba(0,0,0,.35)!important;border-radius:6px!important}",
    ]
  });
  fitReplay(replayer, viewport);
  const camera = createCamera(mount, replayer, viewport, lifetime, cameraZoomEnabled);
  revealCursorOnFirstMove(replayer, lifetime);
  window.addEventListener("resize", () => { fitReplay(replayer, viewport); camera.apply(); }, { signal: lifetime.signal });
  const moveCursor = makeCursorPlacer(replayer);
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
  // The page URL at a given moment: the destination of the latest navigation at
  // or before it, falling back to the segment's initial URL. Shared by the
  // address bar and the chat assistant's readScreen().
  const urlAtTime = (time: number) => {
    const navigated = [...navigationEvents].reverse().find((event) => event.started_at_ms <= time);
    return navigated?.to_url ?? segment.page_url;
  };
  let lastAddressUrl: string | undefined;
  const setAddressBar = (url: string) => {
    if (url === lastAddressUrl) return;
    lastAddressUrl = url;
    const bar = document.querySelector<HTMLElement>("#address-bar");
    if (bar) { bar.textContent = url; bar.title = url; }
  };
  let lastNavigationCheck = requestedSessionTime;
  const scrubber = document.querySelector<HTMLInputElement>("#scrubber")!;
  const nextFocus = nextFocusForSegment(manifest, segment.id, requestedSessionTime);
  // Highlight `hold` pauses playback at a defect so it can land. lastHoldCheckMs
  // tracks how far forward we've evaluated holds, mirroring lastNavigationCheck.
  let lastHoldCheckMs = requestedSessionTime;
  let holdTimer: number | undefined;
  let holdGate: Marker | undefined;
  const updateTimelinePosition = (time: number) => {
    const position = clamp(time / duration * 100, 0, 100);
    currentSessionTime = time;
    revealTabs(manifest, time);
    scrubber.value = String(time);
    document.querySelector<HTMLElement>("#timeline-progress")!.style.width = `${position}%`;
    document.querySelector<HTMLElement>("#timeline-playhead")!.style.left = `${position}%`;
    document.querySelector<HTMLElement>("#current-time")!.textContent = format(time);
    setAddressBar(urlAtTime(time));
    updateActiveMarker(time);
  };
  // Seed the address bar at the seek point before the first frame paints.
  setAddressBar(urlAtTime(requestedSessionTime));
  const playFrom = (time: number) => {
    // Real playback is starting — the session cards yield to the replay.
    // rrweb's seek-while-paused also emits start/pause internally, so the
    // cards cannot key off setPlaying.
    dismissIntro();
    // Once the viewer starts watching, stop coaching.
    dismissOnboarding();
    setEndCard(false);
    const start = tabEnd >= duration - 10 && time >= duration - 10 ? tabStart : clamp(time, tabStart, tabEnd);
    // A direct marker/timeline jump is a new playback baseline. Do not announce
    // navigation transitions that were crossed before the selected point.
    lastNavigationCheck = start;
    clearHold();
    lastHoldCheckMs = start;
    updateTimelinePosition(start);
    replayer.play(start - tabStart);
  };
  const pausePlayback = () => {
    clearHold();
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
      void replay(session, manifest.segments[0], 0, true, selectedPlaybackSpeed).catch(renderError);
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
  // Idle projection retains the same post-navigation context window, keeping
  // the timeline and the overlay on one shared interval.
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
      // announceNavigations arms the auto-hide timer; the pause/scrub handlers
      // pin the overlay via syncNavigationAt(). A requestAnimationFrame scheduled
      // while playing can land one frame after the pause flips `playing` off —
      // that stray tick must not re-arm the timer and un-pin the overlay the
      // pause just set, or the refresh ends on its own a moment later.
      if (playing) announceNavigations(time);
      syncNarration(manifest.markers, time);
      positionCallout();
      if (playing) {
        const holdMarker = manifest.markers.find((marker) => (marker.hold === "beat" || marker.hold === "until_ack") && marker.t_ms > lastHoldCheckMs && marker.t_ms <= time);
        if (holdMarker) triggerHold(holdMarker);
        lastHoldCheckMs = Math.max(lastHoldCheckMs, time);
      }
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
    if (!cameraZoomEnabled) return;
    const event = payload as ReplayEvent;
    if (event.type !== EventType.IncrementalSnapshot || !event.data) return;
    const eventTime = sessionEventTime(event, events, tabStart);
    if (eventTime === undefined || Math.abs(eventTime - currentSessionTime) > CAMERA_SYNC_WINDOW_MS) return;
    const data = event.data;
    if (data.source === IncrementalSource.MouseInteraction && (data.type === MouseInteraction.Click || data.type === MouseInteraction.DblClick) && isRealPoint(data.x, data.y)) camera.noteInteraction(data.x!, data.y!);
    else if (data.source === IncrementalSource.MouseMove) { const position = data.positions?.at(-1); if (position) camera.trackCursor(position.x, position.y); }
    else if (data.source === IncrementalSource.Input) camera.refreshHold();
  });
  // The lead-in cue: glide the synthetic cursor to the upcoming target so it is
  // arriving as the interaction fires. rrweb skips custom events while seeking,
  // so this only runs during real playback.
  replayer.on("custom-event", (payload: unknown) => {
    if (!syntheticCursor) return;
    const event = payload as ReplayEvent;
    if (event.type !== EventType.Custom || event.data?.tag !== "replay-cursor" || typeof event.data.id !== "number") return;
    const center = elementCenter(replayer.getMirror().getNode(event.data.id));
    if (!center) return;
    // Match the glide to the wall-clock gap before the interaction (~the lead
    // divided by playback speed) so it lands on time at any speed.
    const glideMs = Math.max(60, Math.min(500, (CURSOR_APPROACH_MS / selectedPlaybackSpeed) * 0.9));
    moveCursor(center.x, center.y, glideMs);
  });
  replayer.on("mouse-interaction", (payload: unknown) => {
    const interaction = payload as { type?: number; target?: unknown };
    const isClick = interaction.type === MouseInteraction.Click || interaction.type === MouseInteraction.DblClick;
    const isFocus = interaction.type === MouseInteraction.Focus;
    if (!isClick && !isFocus) return;
    const point = syntheticCursor ? elementCenter(interaction.target) : undefined;
    // Re-assert the exact landing after rrweb re-parks the cursor at (0,0) on
    // click; instant, since the lead-in already glided it into place.
    if (point) queueMicrotask(() => moveCursor(point.x, point.y, 0));
    if (point && isClick && cameraZoomEnabled) camera.noteInteraction(point.x, point.y);
    if (isClick) spawnClickRipple(replayer, point ?? {});
    const target = interaction.target;
    if (!isElementLike(target)) return;
    // With rrweb's triggerFocus off, the captured field gets no native focus
    // ring, so stand in the player's own outline for both clicks and focus
    // events. Focus lingers a beat longer since typing usually follows it.
    target.classList.remove("replay-focus-target");
    target.classList.add("replay-focus-target");
    window.setTimeout(() => target.classList.remove("replay-focus-target"), isFocus ? 1_400 : 900);
  });
  // Highlight ring + defect overlay for the active marker. syncNarration calls
  // the installed driver so it tracks both playback and seeks. The callout lives
  // inside the wrapper so the camera transform applies to it for free.
  const highlightCallout = document.createElement("div");
  highlightCallout.className = "highlight-callout";
  highlightCallout.setAttribute("aria-hidden", "true");
  let highlightedNode: ElementLike | undefined;
  const positionCallout = () => {
    if (!highlightedNode) return;
    const center = elementCenter(highlightedNode);
    if (!center) return;
    highlightCallout.style.left = `${center.x}px`;
    highlightCallout.style.top = `${center.y}px`;
  };
  const clearHighlight = () => {
    if (highlightedNode) { highlightedNode.classList.remove("replay-highlight"); highlightedNode = undefined; }
    highlightCallout.remove();
  };
  highlightDriver = (marker) => {
    clearHighlight();
    if (lifetime.signal.aborted || !marker || marker.node_id == null) return;
    const node = replayer.getMirror().getNode(marker.node_id);
    if (!node || !isElementLike(node)) return;
    highlightedNode = node;
    node.classList.add("replay-highlight");
    if (cameraZoomEnabled) { const center = elementCenter(node); if (center) camera.noteInteraction(center.x, center.y); }
    if (marker.defect) {
      highlightCallout.innerHTML = `<div class="hl-row hl-expected"><span class="hl-label">Expected</span><span class="hl-value">${escape(marker.defect.expected)}</span></div><div class="hl-row hl-actual"><span class="hl-label">Actual</span><span class="hl-value">${escape(marker.defect.actual)}</span></div>`;
      replayer.wrapper.appendChild(highlightCallout);
      positionCallout();
    }
  };
  lifetime.signal.addEventListener("abort", clearHighlight, { once: true });
  // A `beat` defect eases playback into a slow dwell instead of freezing the
  // frame, so the viewer keeps agency while the Expected/Actual callout lands.
  // `until_ack` still hard-pauses and waits for Continue — that's the mode for
  // when a genuine stop is wanted.
  const restoreDwellSpeed = () => {
    document.querySelector(".replay-screen")?.classList.remove("is-dwelling");
    if (Math.abs(Number(replayer.config.speed) - selectedPlaybackSpeed) > 1e-6) replayer.setConfig({ speed: selectedPlaybackSpeed });
  };
  const clearHold = () => {
    if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = undefined; restoreDwellSpeed(); }
    if (holdGate) { holdGate = undefined; document.querySelector("#hold-continue")?.classList.remove("is-visible"); }
  };
  const triggerHold = (marker: Marker) => {
    clearHold();
    if (marker.hold === "beat") {
      replayer.setConfig({ speed: HOLD_DWELL_SPEED });
      document.querySelector(".replay-screen")?.classList.add("is-dwelling");
      holdTimer = window.setTimeout(() => { holdTimer = undefined; restoreDwellSpeed(); }, HOLD_BEAT_MS);
    } else {
      holdGate = marker;
      replayer.pause();
      document.querySelector("#hold-continue")?.classList.add("is-visible");
    }
  };
  const continueFromHold = () => {
    if (!holdGate && !holdTimer) return;
    clearHold();
    replayer.play(replayer.getCurrentTime());
  };
  document.querySelector<HTMLButtonElement>("#hold-continue")!.onclick = () => continueFromHold();
  document.querySelector<HTMLButtonElement>("#play")!.onclick = togglePlayback;
  document.querySelectorAll<HTMLButtonElement>("[data-idle-mode]").forEach((button) => button.onclick = () => {
    const mode = button.dataset.idleMode as IdleMode;
    onIdleModeChange?.(mode, currentSessionTime, playing);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-camera-mode]").forEach((button) => button.onclick = () => {
    cameraZoomEnabled = button.dataset.cameraMode === "on";
    try { localStorage.setItem("replay-camera", cameraZoomEnabled ? "on" : "off"); } catch { /* storage may be unavailable in private mode */ }
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
    clearHold(); // a manual speed change overrides any in-flight beat dwell
    onPlaybackSpeedChange?.(speed);
    if (visibleNavigation) showRefresh(visibleNavigation, refreshPinned);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marker], [data-chapter]").forEach((button) => button.onclick = () => {
    dismissIntro();
    setEndCard(false);
    const time = Number(button.dataset.marker ?? button.dataset.chapter);
    const target = segmentAtTime(manifest, eventSets, time);
    if (target && target.id !== segment.id) void replay(session, target, time, false, selectedPlaybackSpeed).catch(renderError);
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
    void replay(session, target, time, shouldResume, selectedPlaybackSpeed).catch(renderError);
  }, { signal: lifetime.signal });
  const jumpTo = (time: number) => {
    dismissIntro();
    setEndCard(false);
    const clamped = clamp(time, 0, duration);
    const target = segmentAtTime(manifest, eventSets, clamped) ?? segment;
    void replay(session, target, clamped, playing, selectedPlaybackSpeed).catch(renderError);
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
    // (top document), never the captured content inside the replay iframe.
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
    clearHold();
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
    await replay(session, tab, Math.max(focus.t_ms, time), true, selectedPlaybackSpeed);
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
  // The chat assistant drives playback through this handle. Raw replay
  // times arrive from the model; the projection maps them onto the timeline.
  registerReplayControl({
    seek: async (rawMs, play) => {
      dismissIntro();
      setEndCard(false);
      const projected = clamp(rawToPlayback(rawMs), 0, duration);
      const target = segmentAtTime(manifest, eventSets, projected) ?? segment;
      await replay(session, target, projected, play, selectedPlaybackSpeed);
      syncNarration(manifest.markers, projected, true);
      return `Playhead moved to replay time ${format(rawMs)} (${play ? "playing" : "paused"}). The viewer is now looking at this moment.`;
    },
    // The chat model speaks raw time; the viewer reads the idle-cropped clock.
    // Project the model's raw ms so chat time labels line up with the scrubber.
    projectTime: (rawMs) => clamp(rawToPlayback(rawMs), 0, duration),
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
        `Replay time: ~${format(playbackToRaw(currentSessionTime))}`,
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
      target.classList.remove("replay-focus-target");
      target.classList.add("replay-focus-target");
      window.setTimeout(() => target?.classList.remove("replay-focus-target"), 2_600);
      const label = (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      return `Highlighted <${target.tagName.toLowerCase()}>${label ? ` "${label}"` : ""} for the viewer.`;
    },
  });
  syncNarration(manifest.markers, requestedSessionTime);
  const openingFrame = Math.max(0, (events.find((event) => event.type === EventType.FullSnapshot)?.timestamp ?? events[0].timestamp) - events[0].timestamp);
  const localTime = clamp(requestedSessionTime - tabStart, openingFrame, tabDuration);
  if (autoplay) playFrom(tabStart + localTime);
  else {
    replayer.pause(localTime);
    updateTimelinePosition(tabStart + localTime);
    syncNavigationAt(tabStart + localTime, true);
  }
}

function prepareTimeline(markers: Marker[], actions: Map<string, AgentAction>, navigationEvents: NavigationEvent[], duration: number, interactions: number[], playbackEnd: number, projectedIdle: TimelineIdleRange[]) {
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
  density.innerHTML = buckets.map((count) => `<i data-timeline-tooltip="Captured activity — ${count ? `${count} event${count === 1 ? "" : "s"}` : "no events"}" style="--level:${Math.max(.08, count / max)}"></i>`).join("");
  document.querySelector<HTMLElement>("#idle-ranges")!.innerHTML = projectedIdle.map((range) => {
    const label = range.mode === "fast_forward"
      ? `Idle time — played at ${range.speed}× (${formatDuration(range.originalDuration)} captured)`
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
  document.querySelector<HTMLElement>("#timeline-markers")!.innerHTML = markers.map((marker, index) => {
    const action = marker.action_id ? actions.get(marker.action_id) : undefined;
    const tooltip = action ? `${marker.label} — ${describeAction(action)}` : marker.label;
    return `<button data-marker="${marker.t_ms}" data-marker-index="${index}"${marker.color ? ` data-marker-color="${marker.color}"` : ""} data-timeline-tooltip="${escape(tooltip)}" aria-label="Jump to marker: ${escape(marker.label)}" aria-current="false" style="left:${clamp(marker.t_ms / duration * 100, 1, 99)}%"><span class="marker-dot"></span></button>`;
  }).join("");
}

function actionsById(manifest: Manifest) {
  return new Map((manifest.actions ?? []).map((action) => [action.id, action]));
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
  // Replays are a general-purpose capture of any flow, not just bug repros,
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
  // Reveal "Show more" only when the note is genuinely truncated by the clamp.
  // The overlay hides via opacity (not display:none), so the note has layout
  // and scrollHeight is measurable even while the end-card is off-screen.
  const notes = document.querySelector<HTMLElement>("#session-notes");
  const notesToggle = document.querySelector<HTMLButtonElement>("#notes-toggle");
  if (notes && notesToggle) {
    if (notes.scrollHeight - notes.clientHeight > 1) notesToggle.hidden = false;
    notesToggle.onclick = () => {
      const expanded = notes.classList.toggle("is-expanded");
      notesToggle.setAttribute("aria-expanded", String(expanded));
      notesToggle.textContent = expanded ? "Show less" : "Show more";
    };
  }
  // The end-card Ask AI button mirrors the deck chat toggle: it shows only when
  // the assistant is available, and opens the same panel.
  const askAi = document.querySelector<HTMLButtonElement>("#ask-ai");
  const chatToggle = document.querySelector<HTMLButtonElement>("#chat-toggle");
  if (askAi && chatToggle) {
    const sync = () => { askAi.hidden = chatToggle.hidden; };
    sync();
    new MutationObserver(sync).observe(chatToggle, { attributes: true, attributeFilter: ["hidden"] });
    askAi.onclick = () => chatToggle.click();
  }
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
  const collapse = document.querySelector<HTMLButtonElement>("#chapters-collapse");
  if (collapse) collapse.onclick = () => {
    chaptersOpen = false;
    apply();
    toggle.focus();
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
  // A NUL separator no page text can contain, so the pair ("a", "bc") never
  // collides with ("ab", "c"). Color rides along so the banner restyles when
  // the active marker's color changes, even if its label and note match.
  const key = marker ? JSON.stringify([marker.label, marker.note ?? "", marker.color ?? "", marker.node_id ?? null, marker.defect ? marker.defect.actual : ""]) : "";
  if (!force && key === lastNarrationKey) return;
  lastNarrationKey = key;
  if (marker) setActionCaption(marker.label, marker.note, marker.color, marker.defect);
  else document.querySelector("#caption")?.classList.remove("is-visible");
  highlightDriver?.(marker);
}
function revealTabs(manifest: Manifest, time: number) {
  document.querySelectorAll<HTMLElement>("[data-segment]").forEach((button) => {
    const segment = manifest.segments.find((item) => item.id === button.dataset.segment);
    const openedAt = tabEvents(manifest).find((event) => event.type === "opened" && event.segment_id === segment?.id)?.t_ms ?? segment?.clock_offset_ms ?? 0;
    button.hidden = Boolean(segment && (openedAt > time || closedAt(manifest, segment.id, time)));
  });
}
function setActionCaption(title: string, copy?: string, color?: Marker["color"], defect?: Defect) {
  const caption = document.querySelector<HTMLElement>("#caption");
  if (!caption) return;
  caption.querySelector("strong")!.textContent = title;
  const detail = caption.querySelector("p")!;
  detail.textContent = defect ? `Expected: ${defect.expected}  —  Actual: ${defect.actual}` : copy ?? "";
  detail.hidden = !detail.textContent;
  // Reflect the active marker's color so the banner draws the eye the same way
  // the timeline dot and chapters entry do. Absent color clears the accent.
  if (color) caption.dataset.color = color;
  else delete caption.dataset.color;
  caption.classList.toggle("has-defect", Boolean(defect));
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
function fitReplay(replayer: Replayer, viewport: { width: number; height: number }) {
  // The camera owns the wrapper transform; fitReplay only sizes the canvas.
  replayer.wrapper.style.width = `${viewport.width}px`;
  replayer.wrapper.style.height = `${viewport.height}px`;
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
async function request<T>(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // A rejected fetch is a transport failure, not an HTTP status: the server is
    // unreachable or too slow. Translate it into something a viewer can act on.
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("The replay server took too long to respond. Check your connection and try again.");
    throw new Error("Could not reach the replay server. Check your connection and try again.");
  }
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error || response.statusText);
  return response.json() as Promise<T>;
}
function renderError(message: string) { app.innerHTML = `<section class=error><p>Replay</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
function renderLoading() { app.innerHTML = `<section class="replay-loading" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><p>Loading replay…</p></section>`; }
