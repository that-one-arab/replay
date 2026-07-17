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

    const play = page.getByRole("button", { name: "Play replay" });
    await page.locator("[data-speed='8']").click();
    await play.click();
    await page.waitForTimeout(250);
    assert.notEqual(await page.locator("#timeline-playhead").getAttribute("style"), "left: 0%;");

    await page.frameLocator(".replayer-wrapper iframe").getByText("Continue").focus();
    await page.keyboard.press("Space");
    assert.equal(await playbackState(page), "Paused");
    await page.keyboard.press("Enter");
    assert.equal(await playbackState(page), "Playing");

    await waitForPaused(page, 2_000);
    assert.equal(await page.locator("#current-time").textContent(), "0:16");
    await play.click();
    await page.waitForTimeout(40);
    assert.equal(await playbackState(page), "Playing");
    assert.notEqual(await page.locator("#current-time").textContent(), "0:16");

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#skip").click();
    await page.locator("[data-speed='8']").click();
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.waitForTimeout(900);
    assert.equal(await playbackState(page), "Playing", "disabling Skip idle should retain the long inactive gap");
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
    await page.locator("[data-speed='8']").click();
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.locator("[data-segment='seg_2']").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-segment='seg_1']").getAttribute("aria-current"), "page");
    await page.frameLocator(".replayer-wrapper iframe").getByText("Invite preview").waitFor();
    assert.equal(await page.locator("[data-segment='seg_2']").isHidden(), false);
    assert.equal(await page.locator("[data-segment='seg_2']").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("#current-time").textContent(), "0:03");
    assert.equal(await page.locator("#total-time").textContent(), "0:07");

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
    assert.equal(await playbackState(page), "Playing");

    await page.locator("#scrubber").evaluate((node) => {
      const scrubber = node as HTMLInputElement;
      scrubber.value = "3500";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      scrubber.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.frameLocator(".replayer-wrapper iframe").getByText("Invite preview").waitFor();
    assert.equal(await page.locator("[data-segment='seg_2']").getAttribute("aria-current"), "page");
    assert.equal(await playbackState(page), "Playing");

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
    assert.equal(await playbackState(page), "Playing");

    await page.locator("[data-speed='8']").click();
    await waitForPaused(page, 2_500);
    assert.equal(await page.locator("#current-time").textContent(), "0:06");
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

function createFixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/api/sessions/fixture/manifest") return json(response, { id: "fixture", title: "Replay control fixture", raw_duration_ms: 16_000, markers: [], segments: [{ id: "seg_1", page_url: "http://fixture/", clock_offset_ms: 0 }] });
    if (url.pathname === "/api/sessions/multi-page/manifest") return json(response, { id: "multi-page", title: "Multi-page fixture", raw_duration_ms: 6_500, markers: [], tab_events: [{ type: "opened", segment_id: "seg_1", t_ms: 0 }, { type: "focused", segment_id: "seg_1", t_ms: 0 }, { type: "opened", segment_id: "seg_2", t_ms: 3_000 }, { type: "focused", segment_id: "seg_2", t_ms: 3_300 }], segments: [{ id: "seg_1", page_url: "http://fixture/onboarding", clock_offset_ms: 0 }, { id: "seg_2", page_url: "http://fixture/invite-preview", clock_offset_ms: 3_000 }] });
    if (url.pathname === "/api/sessions/fixture/events") return json(response, fixtureEvents);
    if (url.pathname === "/api/sessions/multi-page/events") return json(response, url.searchParams.get("segment") === "seg_2" ? inviteEvents : onboardingEvents);
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

const fixtureEvents = [
  { type: 4, data: { href: "http://fixture/", width: 800, height: 450 }, timestamp: 0 },
  { type: 2, data: { node: { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "button", attributes: { id: "fixture-action" }, id: 6, childNodes: [{ type: 3, textContent: "Continue", id: 7 }] }] }] }], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 10 },
  { type: 5, data: { tag: "fixture", payload: { step: "before-idle" } }, timestamp: 1_000 },
  { type: 5, data: { tag: "fixture", payload: { step: "after-idle" } }, timestamp: 16_000 },
];

const inviteEvents = [
  { type: 4, data: { href: "http://fixture/invite-preview", width: 800, height: 450 }, timestamp: 3_000 },
  { type: 2, data: { node: { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: 2 }, { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [{ type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] }, { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [{ type: 2, tagName: "h1", attributes: {}, id: 6, childNodes: [{ type: 3, textContent: "Invite preview", id: 7 }] }] }] }], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 3_010 },
  { type: 5, data: { tag: "fixture", payload: { step: "popup-opened" } }, timestamp: 6_000 },
];

const onboardingEvents = [
  fixtureEvents[0],
  fixtureEvents[1],
  { type: 5, data: { tag: "fixture", payload: { step: "onboarding-complete" } }, timestamp: 2_000 },
];
