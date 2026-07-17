import { createServer } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.REC_DEMO_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
const html = await readFile(resolve(root, "packages/demo/public/index.html"));
const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); });
const sockets = new Set<Socket>();
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

try {
  await new Promise<void>((resolveListen, reject) => server.listen(port, "127.0.0.1", () => resolveListen()).on("error", reject));
  await rec("browser", "start");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const context = browser.contexts()[0];
  if (!context) throw new Error("The recordable Chromium did not expose a browser context.");
  // The browser intentionally persists between agent sessions. Remove an old
  // demo page so repeated runs stay a single, clean replay segment.
  await Promise.all(context.pages().filter((candidate) => candidate.url().startsWith(origin)).map((candidate) => candidate.close()));
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  // Rehearse once unrecorded, mirroring the agent workflow before evidence capture.
  await page.getByRole("button", { name: /set up workspace/i }).click();
  await page.reload({ waitUntil: "networkidle" });
  await rec("start", "--title", "Orbit onboarding verification", "--origin", origin);
  // Give rrweb one flush interval to emit its on-demand full snapshot before
  // the deterministic actions begin, matching an agent that waits for tool
  // confirmation before driving the browser.
  await page.waitForTimeout(600);
  await rec("marker", "Begin workspace setup", "--note", "The customer starts a new Orbit workspace.");
  await page.getByRole("button", { name: /set up workspace/i }).click();
  await page.waitForTimeout(250);
  await rec("marker", "Select the Growth plan", "--note", "The highlighted plan is selected before continuing.");
  await page.getByRole("button", { name: /growth/i }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForTimeout(250);
  await rec("marker", "Name the workspace", "--note", "Northstar Studio is the final workspace name.");
  await page.getByLabel("Workspace name").fill("Northstar Studio");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForTimeout(250);
  await rec("marker", "Confirm the workspace is live", "--note", "A success confirmation proves the onboarding journey completed.");
  await page.getByRole("button", { name: /copy invite link/i }).click();
  const { stdout } = await rec("stop", "--outcome", "verified");
  const url = stdout.match(/Replay:\s+(\S+)/)?.[1];
  if (!url) throw new Error(`rec stop did not return a replay URL:\n${stdout}`);
  const replay = await fetch(url);
  if (!replay.ok) throw new Error(`Replay URL responded with ${replay.status}`);
  console.log(`\nDeterministic replay ready: ${url}`);
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
