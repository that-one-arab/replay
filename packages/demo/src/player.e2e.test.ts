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

function createFixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/api/sessions/fixture/manifest") return json(response, { id: "fixture", title: "Replay control fixture", markers: [], segments: [{ id: "seg_1" }] });
    if (url.pathname === "/api/sessions/fixture/events") return json(response, fixtureEvents);
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
