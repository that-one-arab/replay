/**
 * First-run spotlight tour for the Replay player.
 *
 * The tour is mounted on document.body (not #app) for the same reason the chat
 * panel is (see chat.ts:1-10): the player rebuilds #app's whole subtree on every
 * seek and idle-mode change. Each step targets a CSS selector and a
 * requestAnimationFrame loop re-locates that target every frame, so the
 * spotlight keeps tracking through #app rebuilds, resizes, and scrolls — the
 * rebuilt elements share the same IDs, so the next frame simply finds the new
 * node. Steps whose target is absent or hidden (Ask AI when chat is
 * unavailable, Chapters when there are no markers) are skipped at runtime.
 *
 * Shown once per browser via the replay-onboarding-seen localStorage key.
 *
 * Keyboard: a keydown guard is registered at module load — before main.ts's
 * body runs, which is before the player registers its own playback-key handler
 * on window (capture). So this guard fires first and can stopImmediatePropagation
 * to keep the player dormant while the tour is up. When the tour is inactive it
 * is a no-op, so the player's shortcuts are unaffected.
 */

const SEEN_KEY = "replay-onboarding-seen";
// Bump to re-show the tour after a content redesign.
const VERSION = "1";
const HOLE_PAD = 8;
const TIP_MARGIN = 14;
// Keys the player binds (main.ts onPlaybackKey) — blocked while the tour is up.
const BLOCKED_KEYS = new Set(["ArrowUp", "ArrowDown", "f", "F", "k", "K"]);

type Step = {
  target: string;
  title: string;
  body: string;
};

const STEPS: readonly Step[] = [
  {
    target: "#replay",
    title: "What you're watching",
    body: "A recording of a coding agent's browser session — every click, navigation, and page change it made, captured live.",
  },
  {
    target: "#play",
    title: "Play",
    body: "Press play to start. The agent's long thinking pauses are sped up automatically.",
  },
  {
    target: ".timeline-wrap",
    title: "Timeline",
    body: "Drag to jump to any moment. Bump the speed in the settings menu to skim faster.",
  },
  {
    target: "#chat-toggle",
    title: "Ask AI",
    body: "Ask what happened, or to jump to a moment — the assistant can explain and seek for you.",
  },
  {
    target: "#chapters-toggle",
    title: "Chapters",
    body: "Jump straight to the key moments of the session.",
  },
];

let root: HTMLElement | undefined;
let frame: number | undefined;
let index = 0;
// When localStorage is unavailable, still avoid re-showing within a session.
let shownThisSession = false;

function isSeen(): boolean {
  if (shownThisSession) return true;
  try {
    return localStorage.getItem(SEEN_KEY) === VERSION;
  } catch {
    return false;
  }
}

function markSeen() {
  shownThisSession = true;
  try {
    localStorage.setItem(SEEN_KEY, VERSION);
  } catch {
    /* private mode / blocked storage — in-memory flag still guards this session */
  }
}

export function onboardingActive(): boolean {
  return root?.isConnected ?? false;
}

/** Show the tour once per browser, right after the first replay shell renders. */
export function startOnboardingIfDue() {
  if (onboardingActive() || isSeen()) return;
  build();
  goTo(0);
}

export function dismissOnboarding() {
  dismiss();
}

function build() {
  root = document.createElement("div");
  root.className = "onboarding";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML =
    `<div class="onboarding-masks" aria-hidden="true">` +
    `<div class="onboarding-mask" data-side="top"></div>` +
    `<div class="onboarding-mask" data-side="bottom"></div>` +
    `<div class="onboarding-mask" data-side="left"></div>` +
    `<div class="onboarding-mask" data-side="right"></div>` +
    `</div>` +
    `<div class="onboarding-ring" aria-hidden="true"></div>` +
    `<div class="onboarding-tip" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">` +
    `<span class="onboarding-kicker"><i></i>Replay</span>` +
    `<strong class="onboarding-title" id="onboarding-title"></strong>` +
    `<p class="onboarding-body"></p>` +
    `<div class="onboarding-dots" aria-hidden="true"></div>` +
    `<div class="onboarding-actions">` +
    `<button class="onboarding-skip" type="button">Skip tour</button>` +
    `<button class="onboarding-next" type="button"></button>` +
    `</div></div>`;
  document.body.appendChild(root);
  root.querySelector<HTMLButtonElement>(".onboarding-skip")!.addEventListener("click", dismiss);
  root.querySelector<HTMLButtonElement>(".onboarding-next")!.addEventListener("click", next);
  root.querySelector<HTMLElement>(".onboarding-masks")!.addEventListener("click", dismiss);
  // Double rAF so the entry transition (fade/scale) plays from the initial state.
  requestAnimationFrame(() => requestAnimationFrame(() => root!.classList.add("is-visible")));
  const tick = () => {
    position();
    frame = requestAnimationFrame(tick);
  };
  tick();
}

/** Find the live target element for a step, or null if it's gone or hidden. */
function resolveTarget(step: Step): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(step.target);
  if (!el || el.hasAttribute("hidden")) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return el;
}

/** Advance to step `target`, skipping any steps whose target is missing. */
function goTo(target: number) {
  let i = target;
  while (i < STEPS.length && !resolveTarget(STEPS[i])) i++;
  if (i >= STEPS.length) {
    dismiss();
    return;
  }
  index = i;
  renderStep();
  position();
}

function renderStep() {
  if (!root) return;
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  root.querySelector<HTMLElement>(".onboarding-title")!.textContent = step.title;
  root.querySelector<HTMLElement>(".onboarding-body")!.textContent = step.body;
  root.querySelector<HTMLElement>(".onboarding-dots")!.innerHTML = STEPS.map(
    (_, i) => `<span${i === index ? " class=\"is-active\"" : ""}></span>`,
  ).join("");
  const nextBtn = root.querySelector<HTMLButtonElement>(".onboarding-next")!;
  nextBtn.textContent = last ? "Get started" : "Next";
  nextBtn.focus();
}

function position() {
  if (!root) return;
  const step = STEPS[index];
  const target = resolveTarget(step);
  const ring = root.querySelector<HTMLElement>(".onboarding-ring")!;
  const tip = root.querySelector<HTMLElement>(".onboarding-tip")!;
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (!target) {
    // Target vanished mid-step — dim the whole viewport and hide the ring.
    mask("top", 0, 0, W, H);
    mask("bottom", 0, 0, 0, 0);
    mask("left", 0, 0, 0, 0);
    mask("right", 0, 0, 0, 0);
    ring.style.opacity = "0";
    centerTip(tip);
    return;
  }
  const rect = target.getBoundingClientRect();
  const left = rect.left - HOLE_PAD;
  const top = rect.top - HOLE_PAD;
  const right = rect.right + HOLE_PAD;
  const bottom = rect.bottom + HOLE_PAD;
  // Four rectangular masks tile the viewport except the target, dimming it
  // without a clip-path. (The earlier even-odd clip hole rendered with corner
  // artifacts in Firefox.) Clicks on a mask bubble up to dismiss; the un-masked
  // target stays clickable.
  mask("top", 0, 0, W, Math.max(0, top));
  mask("bottom", 0, Math.max(bottom, 0), W, Math.max(0, H - bottom));
  mask("left", 0, Math.max(top, 0), Math.max(0, left), Math.max(0, bottom - top));
  mask("right", Math.max(right, 0), Math.max(top, 0), Math.max(0, W - right), Math.max(0, bottom - top));
  ring.style.opacity = "1";
  ring.style.left = `${left}px`;
  ring.style.top = `${top}px`;
  ring.style.width = `${right - left}px`;
  ring.style.height = `${bottom - top}px`;
  placeTip(tip, rect);
}

/** Position/size one of the four dimming rectangles. */
function mask(side: string, left: number, top: number, width: number, height: number) {
  const el = root?.querySelector<HTMLElement>(`.onboarding-mask[data-side="${side}"]`);
  if (!el) return;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
}

function centerTip(tip: HTMLElement) {
  tip.style.left = "50%";
  tip.style.top = "50%";
  tip.style.transform = "translate(-50%, -50%)";
}

function placeTip(tip: HTMLElement, rect: DOMRect) {
  const tipRect = tip.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const below = spaceBelow >= tipRect.height + TIP_MARGIN || spaceBottomDominates(rect);
  const top = below ? rect.bottom + TIP_MARGIN : rect.top - tipRect.height - TIP_MARGIN;
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(TIP_MARGIN, Math.min(left, window.innerWidth - tipRect.width - TIP_MARGIN));
  const clampedTop = Math.max(TIP_MARGIN, Math.min(top, window.innerHeight - tipRect.height - TIP_MARGIN));
  tip.style.left = `${left}px`;
  tip.style.top = `${clampedTop}px`;
  tip.style.transform = "none";
}

/** Prefer "below" when the target sits in the top half of the viewport. */
function spaceBottomDominates(rect: DOMRect): boolean {
  return rect.top + rect.height / 2 < window.innerHeight / 2;
}

function next() {
  if (index >= STEPS.length - 1) {
    dismiss();
    return;
  }
  goTo(index + 1);
}

function back() {
  if (index > 0) goTo(index - 1);
}

function dismiss() {
  if (!root) return;
  markSeen();
  if (frame) {
    cancelAnimationFrame(frame);
    frame = undefined;
  }
  root.remove();
  root = undefined;
  index = 0;
}

/** Registered once at module load (before the player's own key handlers). */
function onKey(event: KeyboardEvent) {
  if (!onboardingActive()) return;
  switch (event.key) {
    case "Escape":
      dismiss();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    case "ArrowRight":
      next();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    case "ArrowLeft":
      back();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    default:
      // Enter/Space activate the focused button natively (we only stop the
      // player from also reacting). Everything else the player binds is blocked.
      if (event.key === "Enter" || event.key === " " || event.code === "Space" || BLOCKED_KEYS.has(event.key)) {
        event.stopImmediatePropagation();
      }
  }
}

window.addEventListener("keydown", onKey, true);
