import { createServer } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Locator, type Page } from "playwright-core";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.REC_DEMO_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
const IDLE_REVIEW_MS = 12_000;
const multiTab = process.argv.includes("--multi-tab");
const html = await readFile(resolve(root, "packages/demo/public/index.html"));
const inviteHtml = await readFile(resolve(root, "packages/demo/public/invite-preview.html"));
const assetCss = await readFile(resolve(root, "packages/demo/public/orbit-assets.css"));
const assetSvg = await readFile(resolve(root, "packages/demo/public/orbit-mark.svg"));
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", origin).pathname;
  if (path === "/orbit-assets.css") { response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" }); response.end(assetCss); return; }
  if (path === "/orbit-mark.svg") { response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }); response.end(assetSvg); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(path === "/invite-preview" ? inviteHtml : html);
});
const sockets = new Set<Socket>();
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
const cursorPositions = new WeakMap<Page, { x: number; y: number }>();

try {
  await new Promise<void>((resolveListen, reject) => server.listen(port, "127.0.0.1", () => resolveListen()).on("error", reject));
  await rec("browser", "start");
  let browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  let context = browser.contexts()[0];
  if (!context) throw new Error("The recordable Chromium did not expose a browser context.");
  // The browser intentionally persists between agent sessions. Remove an old
  // demo page so repeated runs stay a single, clean replay segment.
  await Promise.all(context.pages().filter((candidate) => candidate.url().startsWith(origin)).map((candidate) => candidate.close()));
  let page: Page;
  try {
    page = await context.newPage();
  } catch {
    // A saved browser PID can outlive its usable CDP target after Chrome exits.
    // Recover once so a deterministic run never starts against a closed context.
    await rec("browser", "stop");
    await rec("browser", "start");
    browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
    context = browser.contexts()[0];
    if (!context) throw new Error("The restarted Chromium did not expose a browser context.");
    page = await context.newPage();
  }
  await page.goto(origin, { waitUntil: "networkidle" });
  // Rehearse once unrecorded, mirroring the agent workflow before evidence capture.
  await page.getByRole("button", { name: /set up workspace/i }).click();
  await page.reload({ waitUntil: "networkidle" });
  await rec("start", "--title", multiTab ? "Orbit multi-tab browser verification" : "Orbit single-tab verification", "--origin", origin);
  // Give rrweb one flush interval to emit its on-demand full snapshot before
  // the deterministic actions begin, matching an agent that waits for tool
  // confirmation before driving the browser.
  await page.waitForTimeout(600);
  await rec("marker", "Begin workspace setup", "--note", "The customer starts a new Orbit workspace.");
  await humanClick(page, page.getByRole("button", { name: /set up workspace/i }), 720);
  await humanPause(page, 680);
  await rec("marker", "Select the Growth plan", "--note", "The highlighted plan is selected before continuing.");
  await humanClick(page, page.getByRole("button", { name: /growth/i }), 560);
  await humanPause(page, 520);
  // Simulate a genuine decision point. It creates an event-free span longer
  // than rrweb's default 10-second inactive threshold, so Skip idle visibly
  // changes the replay duration and behavior.
  await rec("marker", "Review the selected plan", "--note", "The customer pauses to consider the Growth plan before continuing.");
  await page.waitForTimeout(IDLE_REVIEW_MS);
  await humanClick(page, page.getByRole("button", { name: "Continue" }), 700);
  await humanPause(page, 640);
  await rec("marker", "Name the workspace", "--note", "Northstar Studio is the final workspace name.");
  const workspaceName = page.getByLabel("Workspace name");
  await humanClick(page, workspaceName, 380);
  await workspaceName.press("ControlOrMeta+A");
  await page.keyboard.type("Northstar Studio", { delay: 92 });
  await humanPause(page, 620);
  await humanClick(page, page.getByRole("button", { name: /create workspace/i }), 760);
  await humanPause(page, 720);
  await rec("marker", "Confirm the workspace is live", "--note", "A success confirmation proves the onboarding journey completed.");
  await humanClick(page, page.getByRole("button", { name: /copy invite link/i }), 480);
  let popup: Page | undefined;
  if (multiTab) {
    await rec("marker", "Open the invite preview", "--note", "A same-origin popup opens as a second tab in this browser recording.");
    const popupPromise = context.waitForEvent("page");
    await humanClick(page, page.getByRole("button", { name: /open invite preview/i }), 520);
    popup = await popupPromise;
    await popup.waitForLoadState("networkidle");
    await humanPause(popup, 700);
    await rec("marker", "Confirm popup capture", "--note", "The invite preview interaction verifies the second tab stream.");
    await humanClick(popup, popup.getByRole("button", { name: /copy preview invitation/i }), 540);
  }
  const { stdout } = await rec("stop", "--outcome", "verified");
  const url = stdout.match(/Replay:\s+(\S+)/)?.[1];
  if (!url) throw new Error(`rec stop did not return a replay URL:\n${stdout}`);
  const sessionId = stdout.match(/Stopped\s+(rec_[\w-]+)/)?.[1];
  if (!sessionId) throw new Error(`rec stop did not return a session id:\n${stdout}`);
  const manifest = await fetch(new URL(`/api/sessions/${sessionId}/manifest`, url)).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest responded with ${response.status}`);
    return response.json() as Promise<{ segments: { page_url: string; chunks: string[] }[]; assets?: { source_urls: string[] }[] }>;
  });
  if (manifest.segments.every((segment) => segment.chunks.length === 0)) {
    throw new Error("Recorder captured no rrweb events. The local rec daemon is stale; restart it with `pkill -f 'packages/daemon/dist/main.js'`, then rerun `npm run demo:record`.");
  }
  if (multiTab && (manifest.segments.length !== 2 || manifest.segments[1]?.chunks.length === 0 || !manifest.segments[1]?.page_url.endsWith("/invite-preview"))) {
    throw new Error("Multi-tab recording did not produce a populated invite-preview tab.");
  }
  if (!multiTab && manifest.segments.length !== 1) {
    throw new Error("Single-tab recording unexpectedly captured more than one tab.");
  }
  if (!manifest.assets?.some((asset) => asset.source_urls.includes(`${origin}/orbit-assets.css`)) || !manifest.assets.some((asset) => asset.source_urls.includes(`${origin}/orbit-mark.svg`))) {
    throw new Error("Recorder did not bundle the demo stylesheet and image for self-contained replay.");
  }
  const replay = await fetch(url);
  if (!replay.ok) throw new Error(`Replay URL responded with ${replay.status}`);
  console.log(`\nDeterministic replay ready: ${url}`);
  await popup?.close();
  await page.close();
  await browser.close();
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function rec(...args: string[]) {
  const { stdout, stderr } = await execFile(process.execPath, ["packages/cli/dist/main.js", ...args], { cwd: root });
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  return { stdout, stderr };
}

async function humanClick(page: Page, locator: Locator, dwellMs: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected an interactive target with a visible bounding box.");
  // rrweb samples mouse movement at 50ms. Deliberately use an unhurried path:
  // the replay is a walkthrough, so viewers should be able to follow the
  // cursor's transition before each click.
  const start = cursorPositions.get(page) ?? { x: 84, y: 148 };
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  const duration = Math.min(3_000, Math.max(1_600, distance * 5));
  const steps = Math.ceil(duration / 50);
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    // A symmetric ease-in/ease-out curve: gentle departure, faster travel
    // through the middle, then a deliberate settle over the target.
    const eased = progress < 0.5
      ? 4 * progress ** 3
      : 1 - (-2 * progress + 2) ** 3 / 2;
    await page.mouse.move(start.x + (target.x - start.x) * eased, start.y + (target.y - start.y) * eased);
    await page.waitForTimeout(50);
  }
  cursorPositions.set(page, target);
  await page.waitForTimeout(dwellMs);
  await page.mouse.click(target.x, target.y);
}

async function humanPause(page: Page, durationMs: number) {
  await page.waitForTimeout(durationMs);
}
