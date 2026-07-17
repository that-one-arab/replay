import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Recorder, recHome, sessionsDir, sessionPath, type Outcome, type RecordingManifest, type StartOptions } from "@signit/rec-core";

const port = Number(process.env.REC_PORT ?? 7717);
const recorder = new Recorder();
let cdpEndpoint: string | undefined;

const server = createServer((request, response) => void route(request, response).catch((error: unknown) => reply(response, 500, { error: messageOf(error) })));
server.listen(port, "127.0.0.1", () => console.log(`rec daemon listening on http://127.0.0.1:${port}`));

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const body = request.method === "POST" ? await jsonBody(request) : undefined;
  if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true, cdp_endpoint: cdpEndpoint, ...recorder.status() });
  if (request.method === "POST" && url.pathname === "/api/attach") {
    cdpEndpoint = String(body?.cdp_endpoint ?? "");
    await recorder.attach(cdpEndpoint);
    return reply(response, 200, { cdp_endpoint: cdpEndpoint });
  }
  if (request.method === "POST" && url.pathname === "/api/browser/start") return reply(response, 200, await startBrowser(String(body?.executable ?? "")));
  if (request.method === "POST" && url.pathname === "/api/browser/stop") return reply(response, 200, await stopBrowser());
  if (request.method === "POST" && url.pathname === "/api/sessions/start") {
    if (!cdpEndpoint) throw new Error("No browser attached. Run rec attach --cdp <url> or rec browser start.");
    return reply(response, 201, await recorder.start(body as StartOptions));
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/marker") {
    await recorder.marker(String(body?.label ?? ""), optionalString(body?.note));
    return reply(response, 204);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/stop") return reply(response, 200, await recorder.stop(outcomeOf(body?.outcome), optionalString(body?.notes)));
  if (request.method === "GET" && url.pathname === "/api/sessions/status") return reply(response, 200, recorder.status());
  if (request.method === "GET" && url.pathname === "/api/sessions") return reply(response, 200, await listSessions());
  const replay = /^\/api\/sessions\/([^/]+)\/(manifest|events)$/.exec(url.pathname);
  if (request.method === "GET" && replay) return serveRecording(response, decodeURIComponent(replay[1]), replay[2], url.searchParams.get("segment"));
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return serveAsset(response, url.pathname);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/replay")) return servePlayer(response);
  reply(response, 404, { error: "Not found" });
}

async function startBrowser(executable: string) {
  const statePath = join(recHome(), "browser.json");
  if (existsSync(statePath)) {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as { pid: number; cdp_endpoint: string };
    try { process.kill(saved.pid, 0); cdpEndpoint = saved.cdp_endpoint; await recorder.attach(cdpEndpoint); return { started: false, cdp_endpoint: cdpEndpoint }; } catch { /* stale state */ }
  }
  const browser = executable || process.env.REC_BROWSER_EXECUTABLE || chromeExecutable();
  if (!browser) throw new Error("Chrome was not found. Set REC_BROWSER_EXECUTABLE or use rec attach --cdp.");
  await mkdir(recHome(), { recursive: true });
  const child = spawn(browser, ["--remote-debugging-port=9333", `--user-data-dir=${join(recHome(), "chromium-profile")}`, "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" });
  child.unref();
  cdpEndpoint = "http://127.0.0.1:9333";
  await waitForBrowser(cdpEndpoint);
  await recorder.attach(cdpEndpoint);
  await writeFile(statePath, JSON.stringify({ pid: child.pid, cdp_endpoint: cdpEndpoint }) + "\n");
  return { started: true, cdp_endpoint: cdpEndpoint };
}

async function stopBrowser() {
  const statePath = join(recHome(), "browser.json");
  if (!existsSync(statePath)) return { stopped: false };
  const saved = JSON.parse(await readFile(statePath, "utf8")) as { pid: number };
  try { process.kill(saved.pid, "SIGTERM"); } catch { /* browser already gone */ }
  return { stopped: true };
}

function chromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find(existsSync);
}

async function waitForBrowser(endpoint: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const response = await fetch(`${endpoint}/json/version`); if (response.ok) return; } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Browser did not expose CDP: ${messageOf(lastError)}`);
}

async function listSessions() {
  if (!existsSync(sessionsDir())) return [];
  const entries = await readdir(sessionsDir(), { withFileTypes: true });
  const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try { return JSON.parse(await readFile(join(sessionsDir(), entry.name, "manifest.json"), "utf8")) as RecordingManifest; } catch { return undefined; }
  }));
  return manifests.filter(Boolean).sort((a, b) => Date.parse(b!.created_at) - Date.parse(a!.created_at));
}

async function serveRecording(response: ServerResponse, id: string, resource: string, selected: string | null) {
  const manifest = JSON.parse(await readFile(join(sessionPath(id), "manifest.json"), "utf8")) as RecordingManifest;
  if (resource === "manifest") return reply(response, 200, manifest);
  const segments = selected ? manifest.segments.filter((segment) => segment.id === selected) : manifest.segments;
  const events: unknown[] = [];
  for (const segment of segments) for (const chunk of segment.chunks) {
    const text = gunzipSync(await readFile(join(sessionPath(id), chunk))).toString("utf8");
    for (const line of text.trim().split("\n")) if (line) events.push(JSON.parse(line).event);
  }
  reply(response, 200, events);
}

function servePlayer(response: ServerResponse) {
  const path = resolve(process.cwd(), "packages/player/dist/index.html");
  if (!existsSync(path)) return reply(response, 503, { error: "Player not built. Run pnpm build." });
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(path).pipe(response);
}

function serveAsset(response: ServerResponse, pathname: string) {
  const root = resolve(process.cwd(), "packages/player/dist");
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root) || !existsSync(path)) return reply(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : "text/css" });
  createReadStream(path).pipe(response);
}

function reply(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { try { resolveBody(raw ? JSON.parse(raw) as Record<string, unknown> : {}); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function optionalString(value: unknown) { return typeof value === "string" ? value : undefined; }
function outcomeOf(value: unknown): Outcome | undefined { return value === "reproduced" || value === "verified" || value === "other" ? value : undefined; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
