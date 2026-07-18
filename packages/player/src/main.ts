import { Replayer } from "@rrweb/replay";
import "rrweb/dist/style.css";
import "./style.css";

type Marker = { t_ms: number; label: string; note?: string; placement?: "after_previous" | "before_next" };
type Segment = { id: string; page_url: string; clock_offset_ms: number };
type TabEvent = { t_ms: number; segment_id: string; type: "opened" | "focused" | "closed" };
type NavigationEvent = { segment_id: string; kind: "reload" | "navigate"; started_at_ms: number; committed_at_ms: number; ready_at_ms: number; from_url: string; to_url: string };
type Manifest = { id: string; title: string; markers: Marker[]; segments: Segment[]; tab_events?: TabEvent[]; navigation_events?: NavigationEvent[]; raw_duration_ms?: number };
type ReplayEvent = { timestamp: number; type: number; data?: { source?: number; href?: string; width?: number; height?: number; text?: string; id?: number; x?: number; y?: number; recSynthetic?: "approach"; positions?: { x: number; y: number; id?: number; timeOffset?: number }[] } };
type IdleRange = { start: number; end: number };
type TimelineIdleRange = IdleRange & { originalDuration: number };
type PlaybackProjection = { manifest: Manifest; eventSets: Map<string, ReplayEvent[]>; duration: number; activities: number[]; playbackEnd: number; idleRanges: TimelineIdleRange[]; toPlayback(time: number): number; toRaw(time: number): number };

// Keep the default pace in one place so product teams can tune it without
// changing the replay control behavior.
const DEFAULT_PLAYBACK_SPEED = 1.25;
const TAB_FOCUS_DELAY_MS = 700;
const IDLE_THRESHOLD_MS = 3_000;
const IDLE_RETAINED_MS = 2_000;
const RELOAD_CONTEXT_MS = 750;
const CURSOR_APPROACH_MS = 420;
const REFRESH_INDICATOR_MS = 1_100;
const MIN_REFRESH_INDICATOR_MS = 160;
const MAX_REFRESH_INDICATOR_MS = 1_500;
const TIMELINE_TOOLTIP_DELAY_MS = 550;

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
      humanizeEvents(await request<ReplayEvent[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segment.id)}`)),
    ] as const)));
    const resolvedManifest = { ...manifest, markers: resolveMarkerTimes(manifest, eventSets) };
    let cuttingIdle = true;
    let playbackSpeed = DEFAULT_PLAYBACK_SPEED;
    const present = async (rawTime = 0, autoplay = false) => {
      const projection = projectPlayback(resolvedManifest, eventSets, cuttingIdle);
      activePlayback?.abort();
      renderShell(projection.manifest, cuttingIdle, playbackSpeed);
      prepareTimeline(projection.manifest.markers, projection.manifest.navigation_events ?? [], projection.duration, projection.activities, projection.playbackEnd, projection.idleRanges);
      installTimelineTooltips();
      await replay(projection.manifest, projection.eventSets, projection.duration, projection.manifest.segments[0], projection.toPlayback(rawTime), autoplay, (enabled, requestedTime, shouldAutoplay) => {
        cuttingIdle = enabled;
        void present(projection.toRaw(requestedTime), shouldAutoplay).catch(renderError);
      }, playbackSpeed, (nextSpeed) => { playbackSpeed = nextSpeed; });
    };
    await present();
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest, cuttingIdle: boolean, playbackSpeed: number) {
  const segmentPicker = manifest.segments.length > 1
    ? `<nav class="segment-picker" aria-label="Recorded browser tabs">${manifest.segments.map((segment, index) => `<div class="segment-tab" data-segment="${escape(segment.id)}" title="Opened at ${format(segment.clock_offset_ms)} — ${escape(segment.page_url)}"${index === 0 ? "" : " hidden"}><span>Tab ${index + 1}</span>${escape(segmentLabel(segment.page_url))}</div>`).join("")}</nav>`
    : "";
  const speedControls = [0.25, 0.5, DEFAULT_PLAYBACK_SPEED, 2, 4, 8]
    .map((speed) => `<button data-speed="${speed}"${speed === playbackSpeed ? " class=\"selected\"" : ""}>${speed}×</button>`)
    .join("");
  app.innerHTML = `<main class="replay-screen" aria-label="${escape(manifest.title)}"><div id="replay" aria-label="Browser session replay"></div><div class="video-shade"></div><div class="playback-state"><span></span><b id="stage-status">Paused</b></div>${segmentPicker}<div class="refresh-indicator" id="refresh-indicator" role="status" aria-live="polite"><span class="refresh-spinner" aria-hidden="true"></span><strong id="refresh-label">Page is refreshing</strong></div><div class="caption-card" id="caption"><span class="caption-kicker">SESSION REPLAY</span><strong>Press play to begin</strong><p>The timeline follows the full browser recording.</p></div><section class="control-deck" aria-label="Browser replay controls"><div class="control-main"><button class="play-button" id="play" aria-label="Play replay"><span></span></button><div class="time-readout"><strong id="current-time">0:00</strong><span>/ <span id="total-time">0:00</span></span></div><div class="speed-control" role="group" aria-label="Playback speed">${speedControls}</div><button class="skip-button${cuttingIdle ? " active" : ""}" id="skip" aria-label="${cuttingIdle ? "Cut idle time" : "Keep idle time"}" aria-pressed="${cuttingIdle}"><span>✂</span> Cut idle <b id="idle-summary"></b></button></div><div class="timeline-wrap"><div class="timeline-idle" id="idle-ranges" aria-label="Idle periods"></div><div class="timeline-navigations" id="navigation-events" aria-label="Page navigations"></div><div class="timeline-density" id="density"></div><div class="timeline-progress" id="timeline-progress"></div><div class="timeline-playhead" id="timeline-playhead" aria-hidden="true"></div><div class="timeline-markers" id="timeline-markers"></div><input id="scrubber" class="scrubber" type="range" min="0" value="0" step="10" aria-label="Browser session timeline" /></div></section><div class="timeline-tooltip" id="timeline-tooltip" role="tooltip" aria-hidden="true"></div></main>`;
}

async function replay(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, duration: number, segment: Segment | undefined, requestedSessionTime: number, autoplay = false, onCutIdleChange?: (enabled: boolean, requestedTime: number, autoplay: boolean) => void, playbackSpeed = DEFAULT_PLAYBACK_SPEED, onPlaybackSpeedChange?: (speed: number) => void) {
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
    insertStyleRules: [".rec-focus-target{outline:3px solid #6956ff!important;outline-offset:3px!important;box-shadow:0 0 0 7px rgba(105,86,255,.18)!important;border-radius:4px!important}"]
  });
  fitReplay(mount, replayer, viewport);
  window.addEventListener("resize", () => fitReplay(mount, replayer, viewport), { signal: lifetime.signal });
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
      void replay(manifest, eventSets, duration, manifest.segments[0], 0, true, onCutIdleChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
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
  const hideRefresh = () => {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    visibleNavigation = undefined;
    refreshPinned = false;
    document.querySelector<HTMLElement>("#refresh-indicator")!.classList.remove("is-visible");
  };
  const showRefresh = (navigation: NavigationEvent, pinned = false) => {
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
    onCutIdleChange?.(document.querySelector<HTMLButtonElement>("#skip")!.getAttribute("aria-pressed") !== "true", currentSessionTime, playing);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((button) => button.onclick = () => {
    document.querySelector(".speed-control .selected")?.classList.remove("selected");
    button.classList.add("selected");
    const speed = Number(button.dataset.speed);
    selectedPlaybackSpeed = speed;
    replayer.setConfig({ speed });
    onPlaybackSpeedChange?.(speed);
    if (visibleNavigation) showRefresh(visibleNavigation, refreshPinned);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marker]").forEach((button) => button.onclick = () => {
    const time = Number(button.dataset.marker);
    const target = segmentAtTime(manifest, eventSets, time);
    if (target && target.id !== segment.id) void replay(manifest, eventSets, duration, target, time, false, onCutIdleChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
    else {
      playFrom(time);
      syncNarration(manifest.markers, time);
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
    resumeAfterScrub = playing;
    if (playing) pausePlayback();
  };
  scrubber.addEventListener("pointerdown", beginScrub, { signal: lifetime.signal });
  scrubber.addEventListener("input", () => {
    beginScrub();
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
    void replay(manifest, eventSets, duration, target, time, shouldResume, onCutIdleChange, selectedPlaybackSpeed, onPlaybackSpeedChange).catch(renderError);
  }, { signal: lifetime.signal });
  const onPlaybackKey = (event: KeyboardEvent) => {
    const isPlaybackKey = event.key === "Enter" || event.key === " " || event.key === "Spacebar" || event.code === "Space";
    if (!isPlaybackKey || event.repeat || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    togglePlayback();
  };
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
    await replay(manifest, eventSets, duration, tab, Math.max(focus.t_ms, time), true, onCutIdleChange, selectedPlaybackSpeed, onPlaybackSpeedChange);
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
    syncNavigationAt(tabStart + localTime, true);
  }
}

function projectPlayback(manifest: Manifest, eventSets: Map<string, ReplayEvent[]>, cuttingIdle: boolean): PlaybackProjection {
  const playbackEnd = eventEndTime(manifest, eventSets);
  const activities = activityTimes(manifest, eventSets);
  const navigationEvents = resolvedNavigationEvents(manifest, eventSets);
  const rawIdle = idleRanges(activities, playbackEnd);
  const ranges = cuttingIdle ? rawIdle : [];
  const toPlayback = (time: number) => {
    let removed = 0;
    for (const range of ranges) {
      if (time >= range.end) { removed += range.end - range.start - IDLE_RETAINED_MS; continue; }
      if (time > range.start) return range.start - removed + (time - range.start) * IDLE_RETAINED_MS / (range.end - range.start);
      break;
    }
    return time - removed;
  };
  const toRaw = (time: number) => {
    let removed = 0;
    for (const range of ranges) {
      const compactStart = range.start - removed;
      const compactEnd = compactStart + IDLE_RETAINED_MS;
      if (time >= compactEnd) { removed += range.end - range.start - IDLE_RETAINED_MS; continue; }
      if (time > compactStart) return range.start + (time - compactStart) * (range.end - range.start) / IDLE_RETAINED_MS;
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
  const projectedIdle = rawIdle.map((range) => ({ start: toPlayback(range.start), end: toPlayback(range.end), originalDuration: range.end - range.start }));
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

function prepareTimeline(markers: Marker[], navigationEvents: NavigationEvent[], duration: number, interactions: number[], playbackEnd: number, projectedIdle: TimelineIdleRange[]) {
  const density = document.querySelector<HTMLElement>("#density")!;
  const buckets = Array.from({ length: 72 }, () => 0);
  interactions.forEach((time) => { buckets[Math.min(buckets.length - 1, Math.floor(time / duration * buckets.length))] += 1; });
  const max = Math.max(1, ...buckets);
  density.innerHTML = buckets.map((count) => `<i data-timeline-tooltip="Recorded activity — ${count ? `${count} event${count === 1 ? "" : "s"}` : "no events"}" style="--level:${Math.max(.08, count / max)}"></i>`).join("");
  document.querySelector<HTMLElement>("#idle-ranges")!.innerHTML = projectedIdle.map((range) => {
    const label = nearlyEqual(range.originalDuration, range.end - range.start) ? `Idle time — ${formatDuration(range.originalDuration)}` : `Idle time — reduced from ${formatDuration(range.originalDuration)} to ${formatDuration(range.end - range.start)}`;
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
  document.querySelector<HTMLElement>("#idle-summary")!.textContent = projectedIdle.length ? `${projectedIdle.length} gap${projectedIdle.length === 1 ? "" : "s"}` : "";
  document.querySelector<HTMLElement>("#timeline-markers")!.innerHTML = markers.map((marker, index) => `<button data-marker="${marker.t_ms}" data-marker-index="${index}" data-timeline-tooltip="${escape(`Marker — ${marker.label}${marker.note ? `: ${marker.note}` : ""}`)}" aria-label="Jump to marker: ${escape(marker.label)}" aria-current="false" style="left:${clamp(marker.t_ms / duration * 100, 1, 99)}%"><span class="marker-label">${escape(marker.label)}</span><span class="marker-stem"></span></button>`).join("");
}

function updateActiveMarker(time: number) {
  const markers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-marker]"));
  const active = markers.filter((marker) => Number(marker.dataset.marker) <= time + 450).at(-1);
  markers.forEach((marker) => {
    const selected = marker === active;
    marker.classList.toggle("is-active", selected);
    marker.setAttribute("aria-current", selected ? "step" : "false");
  });
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
function setActionCaption(title: string, copy: string) { document.querySelector<HTMLElement>("#caption strong")!.textContent = title; document.querySelector<HTMLElement>("#caption p")!.textContent = copy; }
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
  for (const event of events) {
    // Playwright's raw move stream often represents instantaneous driver jumps,
    // not a useful human gesture. Reconstruct that gesture from actual targets.
    if (event.type === 3 && event.data?.source === 1) continue;
    const adjusted = { ...event, timestamp: event.timestamp + addedDelay, data: event.data ? { ...event.data } : undefined };
    const pointer = pointerPosition(adjusted);
    if (isDirectPointerInteraction(adjusted) && pointer && (!cursor || adjusted.timestamp - cursor.t >= 280)) {
      const approachAt = Math.max(lastEmittedAt + 1, adjusted.timestamp - CURSOR_APPROACH_MS);
      if (approachAt < adjusted.timestamp - 45) {
        // A single endpoint still lets rrweb paint the cursor directly on the
        // target. Give it a short, timed path instead. The first path starts
        // at the visible origin; later paths continue from the prior target.
        const origin = cursor ?? { x: 0, y: 0 };
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
    if (isVisibleShortFill(adjusted)) {
      const text = adjusted.data!.text!;
      const characters = Array.from(text);
      for (let index = 0; index < characters.length; index += 1) {
        const typed = characters.slice(0, index + 1).join("");
        output.push({ ...adjusted, timestamp: adjusted.timestamp + (index + 1) * 85, data: { ...adjusted.data, text: typed } });
      }
      addedDelay += characters.length * 85;
      lastEmittedAt = output.at(-1)!.timestamp;
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
function fitReplay(mount: HTMLElement, replayer: Replayer, viewport: { width: number; height: number }) {
  const scale = Math.min(mount.clientWidth / viewport.width, mount.clientHeight / viewport.height);
  replayer.wrapper.style.width = `${viewport.width}px`;
  replayer.wrapper.style.height = `${viewport.height}px`;
  replayer.wrapper.style.transform = `scale(${scale})`;
}
function isTextEntryTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; type?: string };
  if (element.isContentEditable || ["TEXTAREA", "SELECT"].includes(element.tagName ?? "")) return true;
  if (element.tagName !== "INPUT") return false;
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes((element.type ?? "text").toLowerCase());
}
type ElementLike = { nodeType: number; classList: DOMTokenList; getAttribute(name: string): string | null; textContent: string | null; tagName: string };
function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }
function readableTarget(target: ElementLike) { const text = target.getAttribute("aria-label") || target.textContent?.trim() || target.tagName.toLowerCase(); return `“${text.replace(/\s+/g, " ").slice(0, 64)}”`; }
async function request<T>(url: string) { const response = await fetch(url); if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error); return response.json() as Promise<T>; }
function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function formatDuration(ms: number) { return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
