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
  process.env.REC_BROWSER_EXECUTABLE,
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
    await page.goto(`${origin}/replay?id=fixture`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("[data-idle-range]").count(), 2);
    assert.equal(await page.locator("[data-navigation-event]").count(), 1);
    assert.match(await page.locator("[data-navigation-event]").getAttribute("title") ?? "", /^Page refreshed — 0\.1s transition$/);
    assert.equal(await page.locator("[data-idle-range]").first().getAttribute("title"), "Idle reduced from 6.2s to 2.0s");
    assert.equal(await page.locator("#idle-summary").textContent(), "2 gaps");
    assert.equal(await page.locator("#skip").getAttribute("aria-pressed"), "true");
    assert.match((await page.locator("#skip").textContent()) ?? "", /Cut idle/);

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

    await page.locator("[data-speed='8']").click();
    await waitForPaused(page, 2_000);
    assert.equal(await page.locator("#current-time").textContent(), "0:07");
    await play.click();
    await page.waitForTimeout(40);
    assert.match((await playbackState(page)) ?? "", /^(Playing|Paused)$/);
    assert.notEqual(await page.locator("#current-time").textContent(), "0:07");

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#skip").click();
    await page.locator("[data-speed='8']").click();
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.waitForTimeout(900);
    assert.equal(await playbackState(page), "Playing", "disabling Cut idle should retain the long inactive gap");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("paused seeks show a recorded navigation only inside its transition interval", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=navigation-window`, { waitUntil: "networkidle" });
    await page.locator("#skip").click();
    await page.waitForFunction(() => document.querySelector("#skip")?.getAttribute("aria-pressed") === "false");
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
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "seeking outside the recorded navigation interval clears the indicator");

    await seek(3_700);
    await waitForRefresh(page, 1_000);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), true, "the refresh cue retains its recorded post-ready context for a seekable timeline interval");

    await seek(3_900);
    await page.waitForTimeout(75);
    assert.equal(await page.locator("#refresh-indicator").evaluate((element) => element.classList.contains("is-visible")), false, "the refresh cue ends at its declared context boundary");
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("browser replay creates and focuses a new tab at its recorded time", { skip: !chrome }, async () => {
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
    assert.equal(await page.locator(".segment-picker").getAttribute("aria-label"), "Recorded browser tabs");
    assert.equal(await page.locator(".segment-picker button").count(), 0, "tab state is not manually selectable");
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), true);
    await page.locator("[data-speed='1.25']").click();
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.locator("[data-segment='seg_2']").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    await page.frameLocator(".replayer-wrapper iframe").getByText("Invite preview").waitFor();
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), false);
    assert.equal(await page.locator("[data-segment='seg_2']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("#current-time").textContent(), "0:02", "the focus transition follows the compacted timeline");
    assert.equal(await page.locator("#total-time").textContent(), "0:04");

    await page.locator("[data-speed='1.25']").click();
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

    await page.locator("[data-speed='8']").click();
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

test("browser replay follows recorded focus returns and hides closed tabs", { skip: !chrome }, async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", () => resolveListen()).on("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/replay?id=focus-cycle`, { waitUntil: "networkidle" });

    await page.locator("[data-speed='8']").click();
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
    if (url.pathname === "/api/sessions/fixture/manifest") return json(response, { id: "fixture", title: "Replay control fixture", raw_duration_ms: 16_000, markers: [], navigation_events: [{ segment_id: "seg_1", kind: "reload", started_at_ms: 7_950, committed_at_ms: 8_000, ready_at_ms: 8_010, from_url: "http://fixture/", to_url: "http://fixture/" }], segments: [{ id: "seg_1", page_url: "http://fixture/", clock_offset_ms: 0 }] });
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
  throw new Error("Replay did not announce the recorded refresh in time.");
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

const fixtureRecordingStartedAt = 1_700_000_000_000;
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
].map((event) => ({ ...event, timestamp: event.timestamp + fixtureRecordingStartedAt }));

function fixtureSnapshot() {
  return { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "button", attributes: { id: "fixture-action" }, id: 6, childNodes: [{ type: 3, textContent: "Continue", id: 7 }] }] }] }], id: 1 };
}

const inviteEvents = [
  { type: 4, data: { href: "http://fixture/invite-preview", width: 800, height: 450 }, timestamp: 3_000 },
  { type: 2, data: { node: { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "h1", attributes: {}, id: 6, childNodes: [{ type: 3, textContent: "Invite preview", id: 7 }] }] }] }], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 3_010 },
  { type: 5, data: { tag: "fixture", payload: { step: "popup-opened" } }, timestamp: 6_000 },
].map((event) => ({ ...event, timestamp: event.timestamp + fixtureRecordingStartedAt }));

const onboardingEvents = [
  fixtureEvents[0],
  fixtureEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "onboarding-complete" } }, timestamp: fixtureRecordingStartedAt + 2_000 },
];

const focusCycleOnboardingEvents = [
  fixtureEvents[0],
  fixtureEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "returned-to-main-tab" } }, timestamp: fixtureRecordingStartedAt + 6_000 },
];
const focusCycleInviteEvents = [
  inviteEvents[0],
  inviteEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "background-tab-closed" } }, timestamp: fixtureRecordingStartedAt + 6_000 },
];
