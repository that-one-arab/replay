import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const playerDist = resolve(root, "packages/player/dist");
const chrome = [
  process.env.REPLAY_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((path): path is string => Boolean(path && existsSync(path)));

test("replay controls show progress, accept keyboard input, restart, and skip inactive time", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // These assertions drive the controls of a returning viewer. Seed the
    // first-run onboarding flag so the spotlight-tour mask can't intercept the
    // mouse/keyboard input below.
    await page.addInitScript(() => { try { localStorage.setItem("replay-onboarding-seen", "1"); } catch { /* storage blocked */ } });
    await page.goto(`${origin}/replay?id=fixture`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("[data-idle-range]").count(), 2);
    assert.equal(await page.locator("[data-navigation-event]").count(), 1);
    assert.equal(await page.locator("[data-marker]").count(), 3, "markers are persistent timeline chapters");
    assert.equal(await page.locator("[data-marker]").first().getAttribute("aria-label"), "Jump to marker: Action begins");
    assert.equal(await page.locator("[data-marker]").first().locator(".marker-dot").count(), 1, "markers use a focused timeline dot instead of a persistent label");
    assert.match(await page.locator("[data-navigation-event]").getAttribute("data-timeline-tooltip") ?? "", /^Page refreshed — 0\.1s transition$/);
    const timelineBox = await page.locator("#scrubber").boundingBox();
    if (!timelineBox) throw new Error("Timeline scrubber is not visible.");
    const navigationLeft = Number((await page.locator("[data-navigation-event]").evaluate((element) => element.style.left)).replace("%", ""));
    await page.mouse.move(timelineBox.x + timelineBox.width * navigationLeft / 100, timelineBox.y + timelineBox.height / 2);
    await page.waitForTimeout(425);
    assert.equal(await page.locator("#timeline-tooltip").evaluate((element) => element.classList.contains("is-visible")), false, "timeline descriptions wait before appearing");
    await page.waitForTimeout(175);
    assert.equal(await page.locator("#timeline-tooltip").textContent(), "Action confirmed", "a marker takes hover priority and shows only its title");
    assert.equal(await page.locator("[data-idle-range]").first().getAttribute("data-timeline-tooltip"), "Idle time — reduced from 6.2s to 2.0s");
    assert.match(await page.locator("#idle-summary").textContent() ?? "", /^2 gaps · .+ skipped$/);
    assert.equal(await page.locator("[data-idle-mode='cut']").evaluate((element) => element.classList.contains("selected")), true);
    await selectIdleMode(page, "fast_forward");
    await page.waitForFunction(() => document.querySelector("[data-idle-mode='fast_forward']")?.classList.contains("selected") === true);
    assert.equal(await page.locator("[data-idle-range]").first().getAttribute("data-timeline-tooltip"), "Idle time — played at 8× (6.2s captured)");
    await selectIdleMode(page, "cut");
    await page.waitForFunction(() => document.querySelector("[data-idle-mode='cut']")?.classList.contains("selected") === true);

    const play = page.getByRole("button", { name: "Play replay" });
    await play.click();
    await waitForRefresh(page, 5_000);
    assert.notEqual(await page.locator("#current-time").textContent(), "0:07", "reload context remains visible before the next compacted idle interval");

    // Recreating the replay during a seek must also reset transient navigation
    // UI from the old replay instance. The refresh did not occur at time zero.
    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = "0";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "seeking away from a reload clears its refresh indicator");

    // rrweb rebuilds from historical events when seeking forward. That rebuild
    // includes the old navigation meta event, but it is not a refresh happening
    // at the selected time.
    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = "6000";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "seeking past a reload does not announce it again");

    const replayAction = page.frameLocator(".replayer-wrapper iframe").getByText("Continue");
    await replayAction.focus();
    await replayAction.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
    assert.equal(await playbackState(page), "Paused");
    await replayAction.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    assert.equal(await playbackState(page), "Playing");

    const scrubber = page.locator("#scrubber");
    const scrubberBox = await scrubber.boundingBox();
    if (!scrubberBox) throw new Error("Timeline scrubber is not visible.");
    await scrubber.click({ position: { x: scrubberBox.width * .46, y: scrubberBox.height / 2 } });
    await page.keyboard.press("Space");
    assert.equal(await playbackState(page), "Paused", "the range control does not swallow the playback hotkey after a timeline click");
    await page.keyboard.press("Enter");
    assert.equal(await playbackState(page), "Playing");

    await selectSpeed(page, "8");
    await waitForPaused(page, 2_000);
    assert.equal(await page.locator("#current-time").textContent(), "0:07");
    await play.click();
    await page.waitForTimeout(40);
    assert.match((await playbackState(page)) ?? "", /^(Playing|Paused)$/);
    assert.notEqual(await page.locator("#current-time").textContent(), "0:07");

    await page.reload({ waitUntil: "networkidle" });
    await selectIdleMode(page, "preserve");
    await selectSpeed(page, "8");
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.waitForTimeout(900);
    assert.equal(await playbackState(page), "Playing", "Keep idle should retain the long inactive gap");
    await page.locator("[data-marker]").first().click();
    assert.equal(await page.locator("[data-marker]").first().getAttribute("aria-current"), "step", "the selected marker stays visually active");
    assert.equal(await page.locator("#caption strong").textContent(), "Action begins", "selecting a marker updates the narrated chapter");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("the first-run spotlight tour orients a new viewer, then dismisses for good", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=fixture`, { waitUntil: "networkidle" });

    // A first-time viewer gets the tour, opened on the framing step.
    await page.locator(".onboarding-title").waitFor({ state: "visible" });
    assert.equal(await page.locator(".onboarding-title").textContent(), "What you're watching");

    // Steps advance on Next. The fixture has chapters but no chat endpoint, so
    // the Ask AI step (hidden #chat-toggle) is skipped automatically.
    await page.locator(".onboarding-next").click();
    assert.equal(await page.locator(".onboarding-title").textContent(), "Play");
    await page.locator(".onboarding-next").click();
    assert.equal(await page.locator(".onboarding-title").textContent(), "Timeline");
    await page.locator(".onboarding-next").click();
    assert.equal(await page.locator(".onboarding-title").textContent(), "Chapters");
    assert.equal(await page.locator(".onboarding-next").textContent(), "Get started");

    // Finishing the tour dismisses it and records the seen flag.
    await page.locator(".onboarding-next").click();
    assert.equal(await page.locator(".onboarding").count(), 0, "the tour is removed once completed");
    assert.equal(await page.evaluate(() => localStorage.getItem("replay-onboarding-seen")), "1");

    // It does not come back for a returning viewer.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".onboarding").count(), 0, "the tour stays dismissed after reload");

    // A fresh tour (flag cleared) ends as soon as the viewer presses play. The
    // tour is also still intercepting the player's hotkeys: space reaches the
    // focused Next button (advancing the tour) instead of starting playback.
    await page.evaluate(() => localStorage.removeItem("replay-onboarding-seen"));
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".onboarding-title").waitFor({ state: "visible" });
    assert.equal(await playbackState(page), "Paused");
    await page.keyboard.press("Space");
    assert.equal(await playbackState(page), "Paused", "the tour blocks the player's space-to-play shortcut");
    assert.equal(await page.locator(".onboarding-title").textContent(), "Play");
    // The spotlight now sits over the play button, so the click reaches it.
    await page.locator("#play").click({ force: true });
    assert.equal(await page.locator(".onboarding").count(), 0, "pressing play dismisses the tour");
    assert.equal(await playbackState(page), "Playing");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("paused seeks show a captured navigation only inside its transition interval", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=navigation-window`, { waitUntil: "networkidle" });
    await selectIdleMode(page, "preserve");
    await page.waitForFunction(() => document.querySelector("[data-idle-mode='preserve']")?.classList.contains("selected") === true);
    const seek = async (time: number) => page.locator("#scrubber").evaluate((node, value) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = String(value);
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    }, time);

    await seek(3_050);
    await waitForRefresh(page, 1_000);
    assert.equal(await playbackState(page), "Paused");
    assert.equal(await page.locator("#refresh-label").textContent(), "Page is refreshing");

    await seek(7_000);
    await page.waitForTimeout(75);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "seeking outside the captured navigation interval clears the indicator");

    await seek(3_700);
    await waitForRefresh(page, 1_000);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), true, "the refresh cue retains its captured post-ready context for a seekable timeline interval");

    await seek(3_900);
    await page.waitForTimeout(75);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "the refresh cue ends at its declared context boundary");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("browser replay creates and focuses a new tab at its captured time", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=multi-page`, { waitUntil: "networkidle" });

    assert.equal(await page.locator("[data-segment]").count(), 2);
    assert.equal(await page.locator(".segment-picker").getAttribute("aria-label"), "Captured browser tabs");
    assert.equal(await page.locator(".segment-picker button").count(), 0, "tab state is not manually selectable");
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), true);
    await selectSpeed(page, "1.15");
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.locator("[data-segment='seg_2']").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    await page.frameLocator(".replayer-wrapper iframe").getByText("Invite preview").waitFor();
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), false);
    assert.equal(await page.locator("[data-segment='seg_2']").getAttribute("aria-current"), "page");
    // The captured focus is at 3.3s raw; cut idle compacts it to ~2.2s. This is
    // read while seg_2 is autoplaying, so it sits on the 2.5s rounding boundary —
    // assert the compacted band rather than one wall-clock-dependent frame. The
    // strict total-time below is the deterministic proof compaction is applied.
    assert.match(await page.locator("#current-time").textContent() ?? "", /^0:0[23]$/, "the focus transition follows the compacted timeline");
    assert.equal(await page.locator("#total-time").textContent(), "0:04");

    await selectSpeed(page, "1.15");
    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = "1000";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.frameLocator(".replayer-wrapper iframe").getByText("Continue").waitFor();
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), true);
    assert.equal(await page.locator("#current-time").textContent(), "0:01");
    assert.match((await playbackState(page)) ?? "", /^(Playing|Paused)$/);
    if (await playbackState(page) === "Paused") await page.getByRole("button", { name: "Play replay" }).click();
    assert.match((await playbackState(page)) ?? "", /^(Playing|Skipping idle)$/);

    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = "3500";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.frameLocator(".replayer-wrapper iframe").getByText("Invite preview").waitFor();
    assert.equal(await page.locator("[data-segment='seg_2']").getAttribute("aria-current"), "page");
    assert.match((await playbackState(page)) ?? "", /^(Playing|Skipping idle)$/);

    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      const scrub = (time: string) => {
        scrubber.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        scrubber.value = time;
        scrubber.dispatchEvent(new Event("input", { bubbles: true }));
        scrubber.dispatchEvent(new Event("change", { bubbles: true }));
      };
      scrub("5900");
      scrub("3500");
    });
    assert.match((await playbackState(page)) ?? "", /^(Playing|Skipping idle)$/);

    await selectSpeed(page, "8");
    await waitForPaused(page, 2_500);
    assert.equal(await page.locator("#current-time").textContent(), "0:04");
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.frameLocator(".replayer-wrapper iframe").getByText("Continue").waitFor();
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), true);
    assert.equal(await playbackState(page), "Playing");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("browser replay follows captured focus returns and hides closed tabs", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=focus-cycle`, { waitUntil: "networkidle" });

    await selectSpeed(page, "8");
    await page.getByRole("button", { name: "Play replay" }).click();
    await waitForSelectedTab(page, "seg_2", 2_500);
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), false);

    await waitForSelectedTab(page, "seg_1", 2_500);
    await page.frameLocator(".replayer-wrapper iframe").getByText("Continue").waitFor();
    await waitForHidden(page.locator("[data-segment='seg_2']"), 1_500);
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function createFixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/api/sessions/fixture/manifest") return json(response, { id: "fixture", title: "Replay control fixture", raw_duration_ms: 16_000, markers: [{ t_ms: 900, label: "Action begins", note: "The fixture button is activated.", placement: "after_previous" }, { t_ms: 7_900, label: "Page refreshes", note: "The replay rebuilds after the captured reload.", placement: "after_previous" }, { t_ms: 15_900, label: "Action confirmed", note: "The final fixture interaction is visible.", placement: "after_previous" }], navigation_events: [{ segment_id: "seg_1", kind: "reload", started_at_ms: 7_950, committed_at_ms: 8_000, ready_at_ms: 8_010, from_url: "http://fixture/", to_url: "http://fixture/" }], segments: [{ id: "seg_1", page_url: "http://fixture/", clock_offset_ms: 0 }] });
    if (url.pathname === "/api/sessions/navigation-window/manifest") return json(response, { id: "navigation-window", title: "Navigation interval fixture", raw_duration_ms: 16_000, markers: [], navigation_events: [{ segment_id: "seg_1", kind: "reload", started_at_ms: 3_000, committed_at_ms: 3_050, ready_at_ms: 3_100, from_url: "http://fixture/", to_url: "http://fixture/" }], segments: [{ id: "seg_1", page_url: "http://fixture/", clock_offset_ms: 0 }] });
    if (url.pathname === "/api/sessions/multi-page/manifest") return json(response, { id: "multi-page", title: "Multi-page fixture", raw_duration_ms: 6_500, markers: [], tab_events: [{ type: "opened", segment_id: "seg_1", t_ms: 0 }, { type: "focused", segment_id: "seg_1", t_ms: 0 }, { type: "opened", segment_id: "seg_2", t_ms: 3_000 }, { type: "focused", segment_id: "seg_2", t_ms: 3_300 }], segments: [{ id: "seg_1", page_url: "http://fixture/onboarding", clock_offset_ms: 0 }, { id: "seg_2", page_url: "http://fixture/invite-preview", clock_offset_ms: 3_000 }] });
    if (url.pathname === "/api/sessions/focus-cycle/manifest") return json(response, { id: "focus-cycle", title: "Focus lifecycle fixture", raw_duration_ms: 6_500, markers: [], tab_events: [{ type: "opened", segment_id: "seg_1", t_ms: 0 }, { type: "focused", segment_id: "seg_1", t_ms: 0 }, { type: "opened", segment_id: "seg_2", t_ms: 3_000 }, { type: "focused", segment_id: "seg_2", t_ms: 3_300 }, { type: "focused", segment_id: "seg_1", t_ms: 5_000 }, { type: "closed", segment_id: "seg_2", t_ms: 5_600 }], segments: [{ id: "seg_1", page_url: "http://fixture/onboarding", clock_offset_ms: 0 }, { id: "seg_2", page_url: "http://fixture/invite-preview", clock_offset_ms: 3_000 }] });
    if (url.pathname === "/api/sessions/fixture/events") return json(response, fixtureEvents);
    if (url.pathname === "/api/sessions/navigation-window/events") return json(response, fixtureEvents);
    if (url.pathname === "/api/sessions/multi-page/events") return json(response, url.searchParams.get("segment") === "seg_2" ? inviteEvents : onboardingEvents);
    if (url.pathname === "/api/sessions/focus-cycle/events") return json(response, url.searchParams.get("segment") === "seg_2" ? focusCycleInviteEvents : focusCycleOnboardingEvents);
    const path = url.pathname === "/replay" ? resolve(playerDist, "index.html") : resolve(playerDist, `.${url.pathname}`);
    if (!path.startsWith(playerDist) || !existsSync(path)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" });
    response.end(readFileSync(path));
  });
}

function json(response: import("node:http").ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function playbackState(page: Page) { return page.locator("#stage-status").textContent(); }
// Speed and idle options live inside deck menus; open the menu before picking.
async function selectSpeed(page: Page, value: string) {
  await page.locator("#speed-button").click();
  await page.locator(`[data-speed='${value}']`).click();
}
async function selectIdleMode(page: Page, mode: string) {
  await page.locator("#settings-button").click();
  await page.locator(`[data-idle-mode='${mode}']`).click();
}
async function waitForPaused(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await playbackState(page) === "Paused") return;
    await page.waitForTimeout(25);
  }
  throw new Error("Replay did not finish in time.");
}
async function waitForRefresh(page: Page, timeoutMs: number) {
  const indicator = page.locator("#refresh-indicator");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await indicator.evaluate((element) => element.classList.contains("is-visible"))) return;
    await page.waitForTimeout(25);
  }
  throw new Error("Replay did not announce the captured refresh in time.");
}
async function waitForSelectedTab(page: Page, segmentId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(`[data-segment='${segmentId}']`).getAttribute("aria-current") === "page") return;
    await page.waitForTimeout(25);
  }
  throw new Error(`Tab ${segmentId} was not selected in time.`);
}
async function waitForHidden(locator: import("playwright-core").Locator, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isHidden()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Tab did not close in time.");
}

const fixtureCaptureStartedAt = 1_700_000_000_000;
const fixtureEvents = [
  { type: 4, data: { href: "http://fixture/", width: 800, height: 450 }, timestamp: 0 },
  { type: 2, data: { node: { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "button", attributes: { id: "fixture-action" }, id: 6, childNodes: [{ type: 3, textContent: "Continue", id: 7 }] }] }] }], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 10 },
  { type: 3, data: { source: 1, positions: [{ x: 160, y: 100, id: 6, timeOffset: 0 }] }, timestamp: 1_000 },
  { type: 3, data: { source: 2, type: 2, id: 6, x: 160, y: 100, pointerType: 0 }, timestamp: 1_000 },
  { type: 5, data: { tag: "fixture", payload: { step: "before-idle" } }, timestamp: 1_001 },
  { type: 4, data: { href: "http://fixture/", width: 800, height: 450 }, timestamp: 8_000 },
  { type: 2, data: { node: fixtureSnapshot(), initialOffset: { left: 0, top: 0 } }, timestamp: 8_010 },
  { type: 3, data: { source: 1, positions: [{ x: 160, y: 100, id: 6, timeOffset: 0 }] }, timestamp: 16_000 },
  { type: 3, data: { source: 2, type: 2, id: 6, x: 160, y: 100, pointerType: 0 }, timestamp: 16_000 },
  { type: 5, data: { tag: "fixture", payload: { step: "after-idle" } }, timestamp: 16_001 },
].map((event) => ({ ...event, timestamp: event.timestamp + fixtureCaptureStartedAt }));

function fixtureSnapshot() {
  return { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "button", attributes: { id: "fixture-action" }, id: 6, childNodes: [{ type: 3, textContent: "Continue", id: 7 }] }] }] }], id: 1 };
}

const inviteEvents = [
  { type: 4, data: { href: "http://fixture/invite-preview", width: 800, height: 450 }, timestamp: 3_000 },
  { type: 2, data: { node: { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "h1", attributes: {}, id: 6, childNodes: [{ type: 3, textContent: "Invite preview", id: 7 }] }] }] }], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 3_010 },
  { type: 5, data: { tag: "fixture", payload: { step: "popup-opened" } }, timestamp: 6_000 },
].map((event) => ({ ...event, timestamp: event.timestamp + fixtureCaptureStartedAt }));

const onboardingEvents = [
  fixtureEvents[0],
  fixtureEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "onboarding-complete" } }, timestamp: fixtureCaptureStartedAt + 2_000 },
];

const focusCycleOnboardingEvents = [
  fixtureEvents[0],
  fixtureEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "returned-to-main-tab" } }, timestamp: fixtureCaptureStartedAt + 6_000 },
];
const focusCycleInviteEvents = [
  inviteEvents[0],
  inviteEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "background-tab-closed" } }, timestamp: fixtureCaptureStartedAt + 6_000 },
];
