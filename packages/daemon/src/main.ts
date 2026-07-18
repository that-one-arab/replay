import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Recorder, exportSession, recHome, resolveRecConfig, sessionsDir, sessionPath, type BrowserConfig, type Outcome, type RecordingManifest, type StartOptions } from "@rec/core";

const port = Number(process.env.REC_PORT ?? 7717);
const recorder = new Recorder();
let cdpEndpoint: string | undefined;
let managedBrowser = existsSync(join(recHome(), "browser.json"));
let activeBrowserConfig: BrowserConfig | undefined;
const leases = new Map<string, DaemonLease>();
const agentIdleTimeoutMs = configuredDuration("REC_BROWSER_IDLE_TIMEOUT_MS", 30_000);
const daemonIdleTimeoutMs = configuredDuration("REC_DAEMON_IDLE_TIMEOUT_MS", 15 * 60_000);
let agentIdleSince: number | undefined;
let daemonIdleSince: number | undefined;
let lifecycleCheckRunning = false;
let shuttingDown = false;

const server = createServer((request, response) => void route(request, response).catch((error: unknown) => reply(response, 500, { error: messageOf(error) })));
server.listen(port, "127.0.0.1", () => console.log(`rec daemon listening on http://127.0.0.1:${port}`));
const lifecycleTimer = setInterval(() => void enforceLifecycle(), 1_000);
lifecycleTimer.unref();

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const body = request.method === "POST" ? await jsonBody(request) : undefined;
  if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, await health());
  if (request.method === "POST" && url.pathname === "/api/leases/acquire") return reply(response, 201, acquireLease(body));
  if (request.method === "POST" && url.pathname === "/api/leases/renew") return reply(response, 200, renewLease(body));
  if (request.method === "POST" && url.pathname === "/api/leases/release") return reply(response, 200, releaseLease(body));
  if (request.method === "POST" && url.pathname === "/api/daemon/stop") {
    if (recorder.status().state === "recording") throw new Error("Cannot stop the daemon while a recording is active.");
    reply(response, 202, { stopping: true });
    setImmediate(() => void shutdownDaemon());
    return;
  }
  if (request.method === "POST" && (url.pathname === "/api/attach" || url.pathname === "/api/browser/attach")) return reply(response, 200, await attachBrowser(String(body?.cdp_endpoint ?? "")));
  if (request.method === "POST" && (url.pathname === "/api/browser/start" || url.pathname === "/api/browser/ensure")) return reply(response, 200, await startBrowser(String(body?.executable ?? "")));
  if (request.method === "POST" && url.pathname === "/api/browser/stop") return reply(response, 200, await stopBrowser());
  if (request.method === "POST" && url.pathname === "/api/sessions/start") {
    if (!cdpEndpoint) throw new Error("No browser attached. Run rec attach --cdp <url> or rec browser start.");
    const config = await resolveRecConfig();
    return reply(response, 201, await recorder.start({ ...(body as StartOptions), replayDefaults: config.replay }));
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/marker") {
    await recorder.marker(String(body?.label ?? ""), optionalString(body?.note), markerPlacement(body?.placement), markerColor(body?.color));
    return reply(response, 204);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/stop") {
    const stopped = await recorder.stop(outcomeOf(body?.outcome), optionalString(body?.notes));
    const portable = await exportSession(stopped.sessionId);
    return reply(response, 200, { ...stopped, portable_bundle: portable.path, portable_bundle_bytes: portable.bytes });
  }
  if (request.method === "GET" && url.pathname === "/api/sessions/status") return reply(response, 200, recorder.status());
  if (request.method === "GET" && url.pathname === "/api/sessions") return reply(response, 200, await listSessions());
  const shareSession = /^\/api\/sessions\/([^/]+)\/share$/.exec(url.pathname);
  if (request.method === "POST" && shareSession) return reply(response, 200, await shareRecording(decodeURIComponent(shareSession[1]!)));
  const replay = /^\/api\/sessions\/([^/]+)\/(manifest|events)$/.exec(url.pathname);
  if (request.method === "GET" && replay) return serveRecording(response, decodeURIComponent(replay[1]), replay[2], url.searchParams.get("segment"));
  const recordedAsset = /^\/api\/sessions\/([^/]+)\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
  if (request.method === "GET" && recordedAsset) return serveRecordedAsset(response, decodeURIComponent(recordedAsset[1]), recordedAsset[2]);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return serveAsset(response, url.pathname);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/replay")) return servePlayer(response);
  reply(response, 404, { error: "Not found" });
}

async function startBrowser(executable: string) {
  await recoverLostBrowserRecording();
  if (recorder.status().state === "recording") throw new Error("Cannot change browser attachment while a recording is active");
  const resolved = await resolveRecConfig();
  const browserConfig: BrowserConfig = executable ? { ...resolved.browser, executable } : resolved.browser;
  const fingerprint = JSON.stringify({ browser: browserConfig });
  const statePath = join(recHome(), "browser.json");
  if (existsSync(statePath)) {
    try {
      const saved = JSON.parse(await readFile(statePath, "utf8")) as ManagedBrowserState;
      process.kill(saved.pid, 0);
      if (saved.config_fingerprint !== fingerprint) {
        return { managed: true, launched: false, browser_state: "restart_required", browser_config_state: "restart_required", browser_config: browserConfig, active_browser_config: saved.browser_config };
      }
      await waitForBrowser(saved.cdp_endpoint, 5);
      await recorder.attach(saved.cdp_endpoint);
      cdpEndpoint = saved.cdp_endpoint;
      managedBrowser = true;
      activeBrowserConfig = saved.browser_config;
      return browserResponse(false, "ready", browserConfig);
    } catch {
      await unlink(statePath).catch(() => undefined);
    }
  }
  const browser = browserConfig.executable || chromeExecutable();
  if (!browser) throw new Error("Chrome was not found. Set REC_BROWSER_EXECUTABLE or use rec attach --cdp.");
  const managedEndpoint = "http://127.0.0.1:9333";
  if (await browserAvailable(managedEndpoint)) {
    throw new Error(`A browser is already listening at ${managedEndpoint}, but Rec does not own it. Use recording_attach_browser with its endpoint or stop that browser before calling recording_browser_ensure.`);
  }
  await mkdir(recHome(), { recursive: true });
  const launchArgs = ["--remote-debugging-port=9333", `--user-data-dir=${join(recHome(), "chromium-profile")}`, "--no-first-run", "--no-default-browser-check"];
  if (browserConfig.headless) launchArgs.push("--headless=new", `--window-size=${browserConfig.viewport.width},${browserConfig.viewport.height}`);
  const child = spawn(browser, launchArgs, { detached: true, stdio: "ignore" });
  child.unref();
  cdpEndpoint = managedEndpoint;
  try {
    await waitForBrowser(cdpEndpoint);
    if (!child.pid) throw new Error("Rec could not determine the launched Chrome process ID");
    process.kill(child.pid, 0);
    await recorder.attach(cdpEndpoint);
  } catch (error) {
    if (child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* already exited */ } }
    cdpEndpoint = undefined;
    throw error;
  }
  await writeFile(statePath, JSON.stringify({ pid: child.pid, cdp_endpoint: cdpEndpoint, config_fingerprint: fingerprint, browser_config: browserConfig }) + "\n");
  managedBrowser = true;
  activeBrowserConfig = browserConfig;
  return browserResponse(true, "ready", browserConfig);
}

async function stopBrowser() {
  if (recorder.status().state === "recording") throw new Error("Cannot stop the managed browser while a recording is active");
  if (!managedBrowser) return { stopped: false, managed: false };
  const statePath = join(recHome(), "browser.json");
  if (!existsSync(statePath)) return { stopped: false, managed: true };
  const saved = JSON.parse(await readFile(statePath, "utf8")) as { pid: number };
  try { process.kill(saved.pid, "SIGTERM"); } catch { /* browser already gone */ }
  await unlink(statePath).catch(() => undefined);
  await recorder.close();
  cdpEndpoint = undefined;
  managedBrowser = false;
  activeBrowserConfig = undefined;
  return { stopped: true, managed: true };
}

async function attachBrowser(endpoint: string) {
  await recoverLostBrowserRecording();
  if (recorder.status().state === "recording") throw new Error("Cannot change browser attachment while a recording is active");
  if (!isLoopbackEndpoint(endpoint)) throw new Error("Only loopback CDP endpoints are supported. Use http://127.0.0.1:<port>.");
  await waitForBrowser(endpoint, 5);
  await recorder.attach(endpoint);
  cdpEndpoint = endpoint;
  managedBrowser = false;
  activeBrowserConfig = undefined;
  return { managed: false, cdp_endpoint: cdpEndpoint, browser_state: "ready" };
}

async function health() {
  expireLeases();
  const browser = recorder.browserStatus();
  const config = await configDiagnostics();
  return {
    ok: true,
    share_available: Boolean(shareEndpoint()),
    cdp_endpoint: cdpEndpoint,
    managed_browser: managedBrowser,
    browser_state: browser.attached ? "ready" : "unavailable",
    page_count: browser.pageCount,
    navigated_page_count: browser.navigatedPageCount,
    leases: leaseSummary(),
    lifecycle: {
      browser_idle_timeout_ms: agentIdleTimeoutMs,
      daemon_idle_timeout_ms: daemonIdleTimeoutMs,
      ...(agentIdleSince ? { browser_idle_since: new Date(agentIdleSince).toISOString() } : {}),
      ...(daemonIdleSince ? { daemon_idle_since: new Date(daemonIdleSince).toISOString() } : {}),
    },
    ...config,
    ...recorder.status(),
  };
}

type LeaseKind = "agent" | "replay";
type DaemonLease = { id: string; owner: string; kind: LeaseKind; expiresAt: number };

function acquireLease(body: Record<string, unknown> | undefined) {
  const kind = leaseKind(body?.kind);
  const now = Date.now();
  const lease: DaemonLease = {
    id: randomUUID(),
    owner: optionalString(body?.owner) ?? "unknown",
    kind,
    expiresAt: now + leaseTtl(body?.ttl_ms),
  };
  leases.set(lease.id, lease);
  if (kind === "agent") {
    agentIdleSince = undefined;
  }
  daemonIdleSince = undefined;
  return { lease_id: lease.id, expires_at: new Date(lease.expiresAt).toISOString(), ...leaseSummary() };
}

function renewLease(body: Record<string, unknown> | undefined) {
  const id = optionalString(body?.lease_id);
  const lease = id ? leases.get(id) : undefined;
  if (!lease) throw new Error("Daemon lease was not found or has expired.");
  lease.expiresAt = Date.now() + leaseTtl(body?.ttl_ms);
  if (lease.kind === "agent") {
    agentIdleSince = undefined;
  }
  daemonIdleSince = undefined;
  return { lease_id: lease.id, expires_at: new Date(lease.expiresAt).toISOString(), ...leaseSummary() };
}

function releaseLease(body: Record<string, unknown> | undefined) {
  const id = optionalString(body?.lease_id);
  if (id) leases.delete(id);
  void enforceLifecycle();
  return { released: Boolean(id), ...leaseSummary() };
}

function leaseKind(value: unknown): LeaseKind {
  if (value === "agent" || value === "replay") return value;
  throw new Error("Lease kind must be agent or replay.");
}

function leaseTtl(value: unknown) {
  const requested = typeof value === "number" && Number.isFinite(value) ? value : 30_000;
  return Math.max(5_000, Math.min(60_000, Math.round(requested)));
}

function expireLeases(now = Date.now()) {
  for (const [id, lease] of leases) if (lease.expiresAt <= now) leases.delete(id);
}

function leaseSummary() {
  expireLeases();
  let agent = 0;
  let replay = 0;
  for (const lease of leases.values()) if (lease.kind === "agent") agent += 1; else replay += 1;
  return { active_lease_count: agent + replay, agent_lease_count: agent, replay_lease_count: replay };
}

async function enforceLifecycle() {
  if (lifecycleCheckRunning || shuttingDown) return;
  lifecycleCheckRunning = true;
  try {
    const now = Date.now();
    expireLeases(now);
    const recording = recorder.status().state === "recording";
    const { active_lease_count: activeLeases, agent_lease_count: agentLeases } = leaseSummary();
    if (recording || agentLeases > 0) agentIdleSince = undefined;
    else {
      agentIdleSince ??= now;
      if (managedBrowser && now - agentIdleSince >= agentIdleTimeoutMs) await stopBrowser();
    }
    if (recording || activeLeases > 0) daemonIdleSince = undefined;
    else {
      daemonIdleSince ??= now;
      if (now - daemonIdleSince >= daemonIdleTimeoutMs) await shutdownDaemon();
    }
  } finally {
    lifecycleCheckRunning = false;
  }
}

async function shutdownDaemon() {
  if (shuttingDown || recorder.status().state === "recording") return;
  shuttingDown = true;
  clearInterval(lifecycleTimer);
  if (managedBrowser) await stopBrowser().catch(() => undefined);
  else await recorder.close().catch(() => undefined);
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 1_000);
  forceExit.unref();
}

type ManagedBrowserState = { pid: number; cdp_endpoint: string; config_fingerprint?: string; browser_config?: BrowserConfig };
function browserResponse(launched: boolean, browserState: "ready" | "restart_required", config: BrowserConfig) {
  return {
    managed: true,
    launched,
    ...(browserState === "ready" ? { cdp_endpoint: cdpEndpoint } : {}),
    browser_state: browserState,
    browser_config_state: browserState === "ready" ? "matched" : "restart_required",
    browser_config: config,
    ...(activeBrowserConfig ? { active_browser_config: activeBrowserConfig } : {}),
  };
}
async function configDiagnostics() {
  try {
    const config = await resolveRecConfig();
    return { browser_config: config.browser, replay_defaults: config.replay, config_sources: config.sources, config_warnings: config.warnings, browser_config_state: managedBrowser && !activeBrowserConfig ? "restart_required" : "matched" };
  } catch (error) {
    return { config_error: messageOf(error), browser_config_state: "invalid" };
  }
}

/**
 * A browser can disappear while rrweb capture is active (for example, after a
 * machine sleep or a crashed Chrome). Do not leave the daemon permanently
 * recording a dead target: finalize what reached disk, release the CDP facade,
 * and let the next browser ensure/attach create a fresh recording.
 */
async function recoverLostBrowserRecording() {
  if (recorder.status().state !== "recording") return;
  if (cdpEndpoint && await browserAvailable(cdpEndpoint)) return;
  try { await recorder.close(); } catch { /* An empty interrupted capture is intentionally not handed off. */ }
  cdpEndpoint = undefined;
}

function chromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find(existsSync);
}

async function waitForBrowser(endpoint: string, attempts = 30) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { const response = await fetch(`${endpoint}/json/version`); if (response.ok) return; } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Browser at ${endpoint} did not expose CDP: ${messageOf(lastError)}`);
}

async function browserAvailable(endpoint: string) {
  try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; }
}

async function shareRecording(id: string) {
  const endpoint = shareEndpoint();
  if (!endpoint) throw new Error("Sharing is not configured. Set REC_SHARE_URL for this Rec home.");
  if (!existsSync(sessionPath(id))) throw new Error(`Recording ${id} was not found.`);
  const artifact = await exportSession(id);
  const response = await fetch(`${endpoint}/v1/recordings`, {
    method: "POST",
    headers: { "content-type": "application/vnd.rec" },
    body: await readFile(artifact.path),
  });
  const result = await response.json().catch(() => ({})) as { error?: string; shareUrl?: string };
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  if (!result.shareUrl) throw new Error("Share service did not return a share URL.");
  return { sessionId: id, shareUrl: result.shareUrl };
}

function shareEndpoint() { return process.env.REC_SHARE_URL?.replace(/\/$/, "") || undefined; }

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

async function serveRecordedAsset(response: ServerResponse, sessionId: string, assetId: string) {
  const root = sessionPath(sessionId);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RecordingManifest;
  const asset = (manifest.assets ?? []).find((item) => item.id === assetId);
  if (!asset) return reply(response, 404, { error: "Recorded asset not found" });
  const path = resolve(root, asset.path);
  if (!path.startsWith(`${resolve(root, "assets")}/`) || !existsSync(path)) return reply(response, 404, { error: "Recorded asset file not found" });
  response.writeHead(200, { "content-type": asset.content_type, "cache-control": "public, max-age=31536000, immutable" });
  createReadStream(path).pipe(response);
}

function servePlayer(response: ServerResponse) {
  const path = join(playerRoot(), "index.html");
  if (!existsSync(path)) return reply(response, 503, { error: "Player not built. Run pnpm build." });
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(path).pipe(response);
}

function serveAsset(response: ServerResponse, pathname: string) {
  const root = playerRoot();
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root) || !existsSync(path)) return reply(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : "text/css" });
  createReadStream(path).pipe(response);
}

function playerRoot() { return resolve(process.env.REC_PLAYER_DIR ?? resolve(process.cwd(), "packages/player/dist")); }

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
function configuredDuration(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1_000 ? Math.round(value) : fallback;
}
function outcomeOf(value: unknown): Outcome | undefined { return value === "reproduced" || value === "verified" || value === "other" ? value : undefined; }
function markerPlacement(value: unknown) { if (value === undefined || value === "after_previous" || value === "before_next") return value ?? "after_previous"; throw new Error("Marker placement must be after_previous or before_next."); }
function markerColor(value: unknown): "yellow" | undefined { if (value === undefined || value === "default") return undefined; if (value === "yellow") return value; throw new Error("Marker color must be yellow."); }
function isLoopbackEndpoint(value: string) {
  try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; }
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
