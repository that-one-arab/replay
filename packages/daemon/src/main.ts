import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Capture, exportPath, exportSession, replayHome, resolveReplayConfig, sessionsDir, sessionPath, uploadReplay, type ActionInput, type BrowserConfig, type Defect, type Hold, type Outcome, type ReplayManifest, type StartOptions } from "@replay/core";
import { ChatManager, CHAT_TOOLS } from "./chat.js";

const port = Number(process.env.REPLAY_PORT ?? 7717);
const capture = new Capture();
const chatManager = new ChatManager(port, async () => (await resolveReplayConfig()).chat);
let cdpEndpoint: string | undefined;
let managedBrowser = existsSync(join(replayHome(), "browser.json"));
// Set when Replay's controlled Chrome exits without Replay stopping it. Closing that
// window is the user's explicit "I'm done", so the daemon winds down too —
// even past agent leases, since idle MCP sessions relaunch it on demand.
let managedBrowserClosed = false;
let activeBrowserConfig: BrowserConfig | undefined;
const leases = new Map<string, DaemonLease>();
const agentIdleTimeoutMs = configuredDuration("REPLAY_BROWSER_IDLE_TIMEOUT_MS", 30_000);
const daemonIdleTimeoutMs = configuredDuration("REPLAY_DAEMON_IDLE_TIMEOUT_MS", 15 * 60_000);
let agentIdleSince: number | undefined;
let daemonIdleSince: number | undefined;
let lifecycleCheckRunning = false;
let shuttingDown = false;

const server = createServer((request, response) => void route(request, response).catch((error: unknown) => reply(response, 500, { error: messageOf(error) })));
// Clients probe /health before spawning a daemon, so hitting a taken port here
// means a foreign process (or a racing daemon) owns it. Exit with a pointer
// instead of crashing on an unhandled 'error' event.
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE"
    ? `replay daemon: 127.0.0.1:${port} is already in use by another process. Stop it or set REPLAY_PORT to a free port.`
    : `replay daemon: could not listen on 127.0.0.1:${port}: ${messageOf(error)}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`replay daemon listening on http://127.0.0.1:${port}`));
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
    if (capture.status().state === "capture") throw new Error("Cannot stop the daemon while a capture is active.");
    reply(response, 202, { stopping: true });
    setImmediate(() => void shutdownDaemon());
    return;
  }
  if (request.method === "POST" && (url.pathname === "/api/attach" || url.pathname === "/api/browser/attach")) return reply(response, 200, await attachBrowser(String(body?.cdp_endpoint ?? "")));
  if (request.method === "POST" && (url.pathname === "/api/browser/start" || url.pathname === "/api/browser/ensure")) return reply(response, 200, await startBrowser(String(body?.executable ?? "")));
  if (request.method === "POST" && url.pathname === "/api/browser/stop") return reply(response, 200, await stopBrowser());
  if (request.method === "POST" && url.pathname === "/api/sessions/start") {
    if (!cdpEndpoint) throw new Error("No browser attached. Run replay attach --cdp <url> or replay browser start.");
    const config = await resolveReplayConfig();
    return reply(response, 201, await capture.start({ ...(body as StartOptions), replayDefaults: config.replay }));
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/marker") {
    await capture.marker(String(body?.label ?? ""), optionalString(body?.note), markerPlacement(body?.placement), markerColor(body?.color));
    return reply(response, 204);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/highlight") {
    return reply(response, 200, await capture.highlight(highlightInput(body)));
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/action") {
    return reply(response, 200, await capture.action(actionInput(body)));
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/stop") {
    const stopped = await capture.stop(outcomeOf(body?.outcome), optionalString(body?.notes));
    const portable = await exportSession(stopped.sessionId);
    return reply(response, 200, { ...stopped, portable_bundle: portable.path, portable_bundle_bytes: portable.bytes });
  }
  if (request.method === "GET" && url.pathname === "/api/chat/availability") return reply(response, 200, await chatManager.availability());
  if (request.method === "GET" && url.pathname === "/api/chat/tools") return reply(response, 200, CHAT_TOOLS);
  if (request.method === "GET" && url.pathname === "/api/chat/stream") {
    return chatManager.connect(String(url.searchParams.get("chat") ?? ""), String(url.searchParams.get("session") ?? ""), response);
  }
  if (request.method === "POST" && url.pathname === "/api/chat/message") return reply(response, 202, await chatManager.message(String(body?.chat_id ?? ""), String(body?.text ?? "")));
  if (request.method === "POST" && url.pathname === "/api/chat/edit") return reply(response, 202, await chatManager.editMessage(String(body?.chat_id ?? ""), Number(body?.index), String(body?.text ?? "")));
  if (request.method === "POST" && url.pathname === "/api/chat/cancel") return reply(response, 200, chatManager.cancel(String(body?.chat_id ?? "")));
  if (request.method === "POST" && url.pathname === "/api/chat/tool") {
    return reply(response, 200, { result: await chatManager.tool(String(body?.chat_id ?? ""), String(body?.name ?? ""), asObject(body?.arguments)) });
  }
  if (request.method === "POST" && url.pathname === "/api/chat/tool-result") {
    return reply(response, 200, chatManager.toolResult(String(body?.chat_id ?? ""), String(body?.call_id ?? ""), body?.ok !== false, body?.result));
  }
  if (request.method === "GET" && url.pathname === "/api/sessions/status") return reply(response, 200, capture.status());
  if (request.method === "GET" && url.pathname === "/api/sessions") return reply(response, 200, await listSessions());
  const shareSession = /^\/api\/sessions\/([^/]+)\/share$/.exec(url.pathname);
  if (request.method === "POST" && shareSession) return reply(response, 200, await shareReplay(decodeURIComponent(shareSession[1]!)));
  const replay = /^\/api\/sessions\/([^/]+)\/(manifest|events)$/.exec(url.pathname);
  if (request.method === "GET" && replay) return serveReplay(response, decodeURIComponent(replay[1]), replay[2], url.searchParams.get("segment"));
  const capturedAsset = /^\/api\/sessions\/([^/]+)\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
  if (request.method === "GET" && capturedAsset) return serveCapturedAsset(response, decodeURIComponent(capturedAsset[1]), capturedAsset[2]);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return serveAsset(response, url.pathname);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/replay")) return servePlayer(response);
  reply(response, 404, { error: "Not found" });
}

async function startBrowser(executable: string) {
  await recoverLostBrowserCapture();
  if (capture.status().state === "capture") throw new Error("Cannot change browser attachment while a capture is active");
  const resolved = await resolveReplayConfig();
  const browserConfig: BrowserConfig = executable ? { ...resolved.browser, executable } : resolved.browser;
  const fingerprint = JSON.stringify({ browser: browserConfig });
  const statePath = join(replayHome(), "browser.json");
  if (existsSync(statePath)) {
    try {
      const saved = JSON.parse(await readFile(statePath, "utf8")) as ManagedBrowserState;
      process.kill(saved.pid, 0);
      if (saved.config_fingerprint !== fingerprint) {
        return { managed: true, launched: false, browser_state: "restart_required", browser_config_state: "restart_required", browser_config: browserConfig, active_browser_config: saved.browser_config };
      }
      await waitForBrowser(saved.cdp_endpoint, 5);
      await capture.attach(saved.cdp_endpoint);
      cdpEndpoint = saved.cdp_endpoint;
      managedBrowser = true;
      managedBrowserClosed = false;
      activeBrowserConfig = saved.browser_config;
      return browserResponse(false, "ready", browserConfig);
    } catch {
      await unlink(statePath).catch(() => undefined);
    }
  }
  const browser = browserConfig.executable || chromeExecutable();
  if (!browser) throw new Error("Chrome was not found. Set REPLAY_BROWSER_EXECUTABLE or use replay attach --cdp.");
  const managedEndpoint = "http://127.0.0.1:9333";
  if (await browserAvailable(managedEndpoint)) {
    throw new Error(`A browser is already listening at ${managedEndpoint}, but Replay does not own it. Use capture_attach_browser with its endpoint or stop that browser before calling capture_browser_ensure.`);
  }
  await mkdir(replayHome(), { recursive: true });
  const profileDir = join(replayHome(), "chromium-profile");
  const launchArgs = ["--remote-debugging-port=9333", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"];
  if (browserConfig.headless) {
    launchArgs.push("--headless=new", `--window-size=${browserConfig.viewport.width},${browserConfig.viewport.height}`);
  } else {
    // Open the visible window filling the display work area. Playwright drives
    // this browser with a device-metrics override; if the window is smaller than
    // that emulated viewport, Chrome paints the overflow off-screen (the page
    // looks "zoomed in" with edges cut off). A maximized window fits any
    // reasonable viewport, so the common case never clips.
    launchArgs.push("--start-maximized");
    // A headed browser is one a person can see and accidentally touch. Brand its
    // chrome so it is unmistakably Replay's controlled session: a bold purple frame
    // and a labelled profile that live in browser UI, never in the captured page.
    // Seed the profile before Chrome reads it at startup.
    await brandControlledProfile(profileDir);
  }
  const child = spawn(browser, launchArgs, { detached: true, stdio: "ignore" });
  child.unref();
  cdpEndpoint = managedEndpoint;
  try {
    await waitForBrowser(cdpEndpoint);
    if (!child.pid) throw new Error("Replay could not determine the launched Chrome process ID");
    process.kill(child.pid, 0);
    await capture.attach(cdpEndpoint);
  } catch (error) {
    if (child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* already exited */ } }
    cdpEndpoint = undefined;
    throw error;
  }
  await writeFile(statePath, JSON.stringify({ pid: child.pid, cdp_endpoint: cdpEndpoint, config_fingerprint: fingerprint, browser_config: browserConfig }) + "\n");
  managedBrowser = true;
  managedBrowserClosed = false;
  activeBrowserConfig = browserConfig;
  return browserResponse(true, "ready", browserConfig);
}

async function stopBrowser() {
  if (capture.status().state === "capture") throw new Error("Cannot stop the managed browser while a capture is active");
  if (!managedBrowser) return { stopped: false, managed: false };
  const statePath = join(replayHome(), "browser.json");
  if (!existsSync(statePath)) return { stopped: false, managed: true };
  const saved = JSON.parse(await readFile(statePath, "utf8")) as { pid: number };
  try { process.kill(saved.pid, "SIGTERM"); } catch { /* browser already gone */ }
  await unlink(statePath).catch(() => undefined);
  await capture.close();
  cdpEndpoint = undefined;
  managedBrowser = false;
  activeBrowserConfig = undefined;
  return { stopped: true, managed: true };
}

async function attachBrowser(endpoint: string) {
  await recoverLostBrowserCapture();
  if (capture.status().state === "capture") throw new Error("Cannot change browser attachment while a capture is active");
  if (!isLoopbackEndpoint(endpoint)) throw new Error("Only loopback CDP endpoints are supported. Use http://127.0.0.1:<port>.");
  await waitForBrowser(endpoint, 5);
  await capture.attach(endpoint);
  cdpEndpoint = endpoint;
  managedBrowser = false;
  managedBrowserClosed = false;
  activeBrowserConfig = undefined;
  return { managed: false, cdp_endpoint: cdpEndpoint, browser_state: "ready" };
}

async function health() {
  expireLeases();
  const browser = capture.browserStatus();
  const config = await configDiagnostics();
  // Only measure a real, navigated page — an empty or unattached browser has no
  // meaningful viewport, and the check must never block a status poll.
  const viewport = browser.attached && browser.navigatedPageCount > 0 ? await capture.viewportFit() : undefined;
  const baseWarnings = "config_warnings" in config && Array.isArray(config.config_warnings) ? config.config_warnings : [];
  const configWarnings = [...baseWarnings, ...(viewport?.warning ? [viewport.warning] : [])];
  return {
    ok: true,
    share_available: Boolean(shareEndpoint()),
    chat_available: (await chatManager.availability()).available,
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
    config_warnings: configWarnings,
    ...(viewport ? { viewport } : {}),
    ...capture.status(),
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
    await releaseClosedManagedBrowser();
    const replay = capture.status().state === "capture";
    const { active_lease_count: activeLeases, agent_lease_count: agentLeases, replay_lease_count: replayLeases } = leaseSummary();
    if (managedBrowserClosed && !replay && replayLeases === 0) {
      await shutdownDaemon();
      return;
    }
    if (replay || agentLeases > 0) agentIdleSince = undefined;
    else {
      agentIdleSince ??= now;
      if (managedBrowser && now - agentIdleSince >= agentIdleTimeoutMs) await stopBrowser();
    }
    if (replay || activeLeases > 0) daemonIdleSince = undefined;
    else {
      daemonIdleSince ??= now;
      if (now - daemonIdleSince >= daemonIdleTimeoutMs) await shutdownDaemon();
    }
  } finally {
    lifecycleCheckRunning = false;
  }
}

/**
 * Notice when the managed Chrome exited without Replay stopping it — the user
 * closed the controlled window, or it crashed. Finalize any in-flight capture
 * (what reached disk is kept), clear the browser state, and mark the closure
 * so the lifecycle check winds the daemon down once nothing is capturing.
 * Replay-initiated stops (stopBrowser) remove browser.json first and never trip
 * this; an external attached browser is not Replay's to watch.
 */
async function releaseClosedManagedBrowser() {
  if (!managedBrowser) return;
  const statePath = join(replayHome(), "browser.json");
  if (!existsSync(statePath)) return;
  let saved: ManagedBrowserState;
  try { saved = JSON.parse(await readFile(statePath, "utf8")) as ManagedBrowserState; } catch { return; }
  try { process.kill(saved.pid, 0); return; } catch { /* the browser process is gone */ }
  managedBrowserClosed = true;
  try { await capture.close(); } catch { /* an empty interrupted capture is intentionally not handed off */ }
  await unlink(statePath).catch(() => undefined);
  cdpEndpoint = undefined;
  managedBrowser = false;
  activeBrowserConfig = undefined;
}

async function shutdownDaemon() {
  if (shuttingDown || capture.status().state === "capture") return;
  shuttingDown = true;
  clearInterval(lifecycleTimer);
  chatManager.dispose();
  if (managedBrowser) await stopBrowser().catch(() => undefined);
  else await capture.close().catch(() => undefined);
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
    const config = await resolveReplayConfig();
    return { browser_config: config.browser, replay_defaults: config.replay, config_sources: config.sources, config_warnings: config.warnings, browser_config_state: managedBrowser && !activeBrowserConfig ? "restart_required" : "matched" };
  } catch (error) {
    return { config_error: messageOf(error), browser_config_state: "invalid" };
  }
}

/**
 * A browser can disappear while rrweb capture is active (for example, after a
 * machine sleep or a crashed Chrome). Do not leave the daemon permanently
 * replay a dead target: finalize what reached disk, release the CDP facade,
 * and let the next browser ensure/attach create a fresh replay.
 */
async function recoverLostBrowserCapture() {
  if (capture.status().state !== "capture") return;
  if (cdpEndpoint && await browserAvailable(cdpEndpoint)) return;
  try { await capture.close(); } catch { /* An empty interrupted capture is intentionally not handed off. */ }
  cdpEndpoint = undefined;
}

function chromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find(existsSync);
}

const CONTROLLED_PROFILE_NAME = "Replay — controlled session";
// Replay's brand purple (#7C5CFF) as an opaque SkColor (ARGB int). Chrome derives a
// Material tonal palette from this seed and paints the frame / tab strip with it,
// so a headed managed browser reads as branded and unmistakably controlled.
const CONTROLLED_FRAME_COLOR = 0xff7c5cff;
// BrowserColorVariant::kVibrant — keeps the purple hue but boosts chroma so the
// frame is clearly non-default rather than a faint tint. (kTonalSpot=1, kVibrant=3.)
const CONTROLLED_COLOR_VARIANT = 3;

/**
 * Brand a headed managed browser as Replay's controlled session by seeding its
 * profile: a labelled profile pill plus a bold purple frame theme. Both live in
 * Chrome's own UI (never the captured page) and are applied by seeding
 * Preferences — Google Chrome stable ignores --load-extension theme injection.
 * Best-effort: on any failure the browser still launches, just unbranded.
 */
async function brandControlledProfile(profileDir: string) {
  try {
    const preferencesPath = join(profileDir, "Default", "Preferences");
    await mkdir(join(profileDir, "Default"), { recursive: true });
    let preferences: Record<string, unknown> = {};
    if (existsSync(preferencesPath)) {
      try { preferences = JSON.parse(await readFile(preferencesPath, "utf8")) as Record<string, unknown>; } catch { preferences = {}; }
    }
    // Merge in place so any profile state persisted from earlier sessions survives.
    const profile = { ...(preferences.profile as Record<string, unknown> | undefined), name: CONTROLLED_PROFILE_NAME };
    const browser = { ...(preferences.browser as Record<string, unknown> | undefined), theme: { user_color: CONTROLLED_FRAME_COLOR, color_variant: CONTROLLED_COLOR_VARIANT, is_grayscale: false } };
    await writeFile(preferencesPath, JSON.stringify({ ...preferences, profile, browser }));
  } catch (error) {
    console.log(`replay daemon: could not brand the controlled browser: ${messageOf(error)}`);
  }
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

async function shareReplay(id: string) {
  const endpoint = shareEndpoint();
  if (!endpoint) throw new Error("Sharing is not configured. Set REPLAY_SHARE_URL for this Replay home.");
  if (!existsSync(sessionPath(id))) throw new Error(`Replay ${id} was not found.`);
  // stop already exported the artifact; reuse it. exportSession writes exclusively
  // and would otherwise fail with EEXIST when sharing an already-stopped replay.
  const artifact = existsSync(exportPath(id)) ? exportPath(id) : (await exportSession(id)).path;
  const { shareUrl, summaryUrl } = await uploadReplay(endpoint, artifact);
  return { sessionId: id, shareUrl, ...(summaryUrl ? { summaryUrl } : {}) };
}

function shareEndpoint() { return process.env.REPLAY_SHARE_URL?.replace(/\/$/, "") || undefined; }

async function listSessions() {
  if (!existsSync(sessionsDir())) return [];
  const entries = await readdir(sessionsDir(), { withFileTypes: true });
  const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try { return JSON.parse(await readFile(join(sessionsDir(), entry.name, "manifest.json"), "utf8")) as ReplayManifest; } catch { return undefined; }
  }));
  return manifests.filter(Boolean).sort((a, b) => Date.parse(b!.created_at) - Date.parse(a!.created_at));
}

async function serveReplay(response: ServerResponse, id: string, resource: string, selected: string | null) {
  const manifest = JSON.parse(await readFile(join(sessionPath(id), "manifest.json"), "utf8")) as ReplayManifest;
  if (resource === "manifest") return reply(response, 200, manifest);
  const segments = selected ? manifest.segments.filter((segment) => segment.id === selected) : manifest.segments;
  const events: unknown[] = [];
  for (const segment of segments) for (const chunk of segment.chunks) {
    const text = gunzipSync(await readFile(join(sessionPath(id), chunk))).toString("utf8");
    for (const line of text.trim().split("\n")) if (line) events.push(JSON.parse(line).event);
  }
  reply(response, 200, events);
}

async function serveCapturedAsset(response: ServerResponse, sessionId: string, assetId: string) {
  const root = sessionPath(sessionId);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as ReplayManifest;
  const asset = (manifest.assets ?? []).find((item) => item.id === assetId);
  if (!asset) return reply(response, 404, { error: "Captured asset not found" });
  const path = resolve(root, asset.path);
  if (!path.startsWith(`${resolve(root, "assets")}/`) || !existsSync(path)) return reply(response, 404, { error: "Captured asset file not found" });
  response.writeHead(200, { "content-type": asset.content_type, "cache-control": "public, max-age=31536000, immutable" });
  createReadStream(path).pipe(response);
}

function servePlayer(response: ServerResponse) {
  const path = join(playerRoot(), "index.html");
  if (!existsSync(path)) return reply(response, 503, { error: "Player not built. Run pnpm build." });
  // index.html references content-hashed assets, so it must always be fetched
  // fresh — otherwise the browser keeps an old HTML pointing at a stale bundle.
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  createReadStream(path).pipe(response);
}

function serveAsset(response: ServerResponse, pathname: string) {
  const root = playerRoot();
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root) || !existsSync(path)) return reply(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : "text/css" });
  createReadStream(path).pipe(response);
}

function playerRoot() { return resolve(process.env.REPLAY_PLAYER_DIR ?? resolve(process.cwd(), "packages/player/dist")); }

function reply(response: ServerResponse, status: number, value?: unknown) {
  // A failed SSE stream may already hold sent headers; never double-write them.
  if (response.headersSent) return response.end();
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function asObject(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }

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
function actionInput(body: Record<string, unknown> | undefined): ActionInput {
  const id = optionalString(body?.id);
  const tool = optionalString(body?.tool);
  const started = Number(body?.started_at_epoch_ms);
  const finished = Number(body?.finished_at_epoch_ms);
  if (!id || !tool || !Number.isFinite(started) || !Number.isFinite(finished)) {
    throw new Error("An action requires id, tool, started_at_epoch_ms, and finished_at_epoch_ms.");
  }
  const rawMarker = asObject(body?.marker);
  const label = optionalString(rawMarker.label);
  if (body?.marker !== undefined && !label) throw new Error("An action marker requires a label.");
  return {
    id,
    tool,
    argsSummary: optionalString(body?.args_summary),
    startedAtEpochMs: started,
    finishedAtEpochMs: finished,
    ok: body?.ok !== false,
    ...(label ? { marker: { label, note: optionalString(rawMarker.note), color: markerColor(rawMarker.color) } } : {}),
  };
}
function markerColor(value: unknown): "yellow" | "green" | undefined { if (value === undefined || value === "default") return undefined; if (value === "yellow" || value === "green") return value; throw new Error("Marker color must be yellow or green."); }
function holdOf(value: unknown): Hold { if (value === undefined) return "beat"; if (value === "beat" || value === "until_ack" || value === "none") return value; throw new Error("Hold must be beat, until_ack, or none."); }
function defectOf(value: unknown): Defect | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value);
  const expected = optionalString(obj.expected);
  const actual = optionalString(obj.actual);
  if (!expected || !actual) throw new Error("A defect requires both expected and actual.");
  return { expected, actual };
}
function highlightInput(body: Record<string, unknown> | undefined) {
  const defect = defectOf(body?.defect);
  const note = optionalString(body?.note);
  if (defect && note) throw new Error("Provide either a defect or a note, not both.");
  const elementObj = asObject(body?.element);
  const selector = optionalString(elementObj.selector);
  const text = optionalString(elementObj.text);
  return {
    label: optionalString(body?.label),
    note,
    defect,
    hold: holdOf(body?.hold),
    color: markerColor(body?.color),
    element: selector || text ? { ...(selector ? { selector } : {}), ...(text ? { text } : {}) } : undefined,
  };
}
function isLoopbackEndpoint(value: string) {
  try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; }
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
