#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { exportSession, uploadReplay } from "@replay/core";
import { embeddedPlaywrightEnabled, PlaywrightBridge } from "./playwright-bridge.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const endpoint = process.env.REPLAY_DAEMON_URL ?? "http://127.0.0.1:7717";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = process.env.REPLAY_DAEMON_ENTRY ?? resolve(moduleDirectory, "../../daemon/dist/main.js");
let daemonLease: DaemonLease | undefined;

const tools: JsonObject[] = [
  {
    name: "capture_browser_ensure",
    description: "Ensure Replay's dedicated local Chrome is running and return the CDP endpoint that Playwright MCP must use.",
    inputSchema: {
      type: "object",
      properties: {
        browserExecutable: { type: "string", description: "Optional Chrome executable for Replay to launch." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "capture_attach_browser",
    description: "Attach Replay to an explicitly supplied loopback Chrome CDP endpoint. Do not call while capturing.",
    inputSchema: {
      type: "object",
      required: ["cdpEndpoint"],
      properties: {
        cdpEndpoint: { type: "string", description: "Loopback CDP endpoint, for example http://127.0.0.1:9222." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "capture_start",
    description: "Start capture on an attached browser after Playwright MCP has navigated to an in-scope page.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable replay title." },
        origins: { type: "array", items: { type: "string" }, description: "Optional allowed page origins. Defaults to the active page origin." },
        captureCanvas: { type: "boolean", description: "Capture canvas mutations. Disabled by default." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "capture_marker",
    description: "Add a labelled checkpoint to the active replay that is not tied to a browser action. For a checkpoint on an action itself, pass replay_marker on that browser tool call instead.",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string", description: "Short checkpoint label." },
        note: { type: "string", description: "Optional context for the checkpoint." },
        placement: { type: "string", enum: ["after_previous", "before_next"], description: "Narrative placement relative to ordered Playwright actions. Defaults to after_previous." },
        color: { type: "string", enum: ["default", "yellow", "green"], description: "Set to yellow or green for a distinct, highlighted checkpoint. Defaults to a standard checkpoint." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "capture_status",
    description: "Read local capture and browser attachment status. Includes `viewport` (the live emulated viewport vs. the display); when `viewport.clipped` is true the page renders off-screen, and `viewport.recommendedViewport` is a safe size to resize to. Clipping is also reported in `configWarnings`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "capture_stop",
    description: "Stop the active replay, save it locally, and return its local replay URL and portable artifact path. Sharing is a separate, explicit step: call replay_share or use the Share button in the player.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["reproduced", "verified", "other"], description: "Optional replay outcome." },
        notes: { type: "string", description: "Optional handoff notes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "replay_share",
    description: "Explicitly upload a completed portable replay to the configured Replay share service and return its public bearer link.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string", description: "Completed replay ID returned by capture_stop." } },
      additionalProperties: false,
    },
  },
];

const captureToolNames = new Set(tools.map((tool) => String(tool.name)));
const bridge = new PlaywrightBridge();
let embeddedToolsError: string | undefined;

/**
 * Replay's checkpoint parameter, injected into every embedded browser tool
 * schema. It is stripped before the call reaches Playwright, so association
 * with the action is atomic: same request, same identity.
 */
const REPLAY_MARKER_SCHEMA: JsonObject = {
  type: "object",
  description: "Optional replay checkpoint captured atomically with this browser action. Provide it when this action is a meaningful, confirmed step worth labelling in the session replay.",
  required: ["label"],
  properties: {
    label: { type: "string", description: "Short checkpoint label." },
    note: { type: "string", description: "Optional context for the checkpoint." },
    color: { type: "string", enum: ["default", "yellow", "green"], description: "Set to yellow or green for a distinct, highlighted checkpoint." },
  },
  additionalProperties: false,
};

void run();

async function run() {
  await acquireDaemonLease();
  let buffered = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) queue = queue.then(() => handleLine(line));
  });
  process.stdin.on("end", () => {
    if (buffered.trim()) void handleLine(buffered);
    void releaseDaemonLease();
  });
  process.once("SIGTERM", () => { void releaseDaemonLease(); process.exit(0); });
  process.once("SIGINT", () => { void releaseDaemonLease(); process.exit(0); });
}

async function handleLine(line: string) {
  let request: Request;
  try { request = JSON.parse(line) as Request; } catch { return; }
  if (!request.method) return respond(request.id, undefined, { code: -32600, message: "Invalid JSON-RPC request." });
  try {
    const result = await dispatch(request.method, request.params);
    if (request.id !== undefined) respond(request.id, result);
  } catch (error) {
    if (request.id !== undefined) respond(request.id, undefined, { code: -32601, message: messageOf(error) });
  }
}

async function dispatch(method: string, params: unknown): Promise<JsonObject> {
  if (method === "initialize") {
    const requested = object(params).protocolVersion;
    return {
      protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "replay-mcp", version: "0.1.0" },
    };
  }
  if (method === "notifications/initialized") return {};
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: [...tools, ...await embeddedTools()] };
  if (method === "tools/call") {
    const call = object(params);
    const name = requiredString(call.name, "Tool name");
    return callTool(name, object(call.arguments));
  }
  throw new Error(`Unsupported MCP method: ${method}`);
}

async function callTool(name: string, argumentsValue: JsonObject): Promise<JsonObject> {
  try {
    switch (name) {
      case "capture_browser_ensure": return toolResult(await ensureBrowser(argumentsValue));
      case "capture_attach_browser": return toolResult(await attachBrowser(argumentsValue));
      case "capture_start": return toolResult(await startCapture(argumentsValue));
      case "capture_marker": return toolResult(await addMarker(argumentsValue));
      case "capture_status": return toolResult(await captureStatus());
      case "capture_stop": return toolResult(await stopCapture(argumentsValue));
      case "replay_share": return toolResult(await shareReplay(argumentsValue));
      default: return await callBrowserTool(name, argumentsValue);
    }
  } catch (error) {
    return toolError(error);
  }
}

/**
 * The embedded browser tool surface is stock Playwright MCP with one addition:
 * an optional replay_marker parameter on every tool. Listing failures degrade to
 * the replay tools alone instead of breaking the server.
 */
async function embeddedTools(): Promise<JsonObject[]> {
  if (!embeddedPlaywrightEnabled()) return [];
  try {
    const listed = await bridge.listTools();
    embeddedToolsError = undefined;
    return listed.filter((tool) => !captureToolNames.has(String(tool.name))).map(injectReplayMarker);
  } catch (error) {
    embeddedToolsError = messageOf(error);
    process.stderr.write(`replay-mcp: embedded Playwright MCP tools are unavailable: ${embeddedToolsError}\n`);
    return [];
  }
}

function injectReplayMarker(tool: JsonObject): JsonObject {
  const schema = object(tool.inputSchema);
  if (schema.type !== "object") return tool;
  return { ...tool, inputSchema: { ...schema, properties: { ...object(schema.properties), replay_marker: REPLAY_MARKER_SCHEMA } } };
}

async function callBrowserTool(name: string, argumentsValue: JsonObject): Promise<JsonObject> {
  if (!embeddedPlaywrightEnabled()) throw new Error(`Unknown tool: ${name}. Embedded browser tools are disabled by REPLAY_EMBEDDED_PLAYWRIGHT=0.`);
  if (embeddedToolsError) throw new Error(`Unknown tool: ${name}. Embedded Playwright MCP is unavailable: ${embeddedToolsError}`);
  const marker = extractReplayMarker(argumentsValue);
  const cleaned = { ...argumentsValue };
  delete cleaned.replay_marker;
  const endpoint = await ensureDrivableBrowser();
  const actionId = `act_${randomUUID()}`;
  const startedAtEpochMs = Date.now();
  let result: JsonObject;
  try {
    result = await bridge.callTool(endpoint, name, cleaned);
  } catch (error) {
    await postAction({ actionId, tool: name, cleaned, startedAtEpochMs, ok: false, marker });
    throw error;
  }
  const outcome = await postAction({ actionId, tool: name, cleaned, startedAtEpochMs, ok: result.isError !== true, marker });
  if (marker && outcome.warning) {
    const content = Array.isArray(result.content) ? result.content : [];
    return { ...result, content: [...content, { type: "text", text: `replay_marker was not captured: ${outcome.warning}` }] };
  }
  return result;
}

/** Mirror the launcher's rendezvous: reuse an attached browser, else ensure Replay's managed Chrome. */
async function ensureDrivableBrowser(): Promise<string> {
  const health = await ensureDaemon();
  const attached = optionalString(health.cdp_endpoint as Json);
  if (attached) return attached;
  const ensured = object(await api("POST", "/api/browser/ensure", {}));
  return requiredString(ensured.cdp_endpoint as Json, "Replay browser CDP endpoint");
}

/**
 * Report the action (and its optional atomic marker) to the daemon. This must
 * never fail the browser action itself: a daemon hiccup or an idle capture
 * degrades to a warning on the tool result, not a failed drive.
 */
async function postAction(input: { actionId: string; tool: string; cleaned: JsonObject; startedAtEpochMs: number; ok: boolean; marker?: JsonObject }): Promise<{ warning?: string }> {
  try {
    const result = object(await api("POST", "/api/sessions/action", {
      id: input.actionId,
      tool: input.tool,
      args_summary: summarizeArguments(input.cleaned),
      started_at_epoch_ms: input.startedAtEpochMs,
      finished_at_epoch_ms: Date.now(),
      ok: input.ok,
      ...(input.marker ? { marker: input.marker } : {}),
    }, false));
    if (input.marker && result.captured !== true) return { warning: "no replay is active. Call capture_start first." };
    return {};
  } catch (error) {
    return { warning: messageOf(error) };
  }
}

function extractReplayMarker(argumentsValue: JsonObject): JsonObject | undefined {
  const raw = argumentsValue.replay_marker;
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("replay_marker must be an object with a label.");
  const marker = raw as JsonObject;
  const label = requiredString(marker.label, "replay_marker label");
  const color = optionalColor(marker.color);
  return { label, ...(optionalString(marker.note) ? { note: optionalString(marker.note) } : {}), ...(color ? { color } : {}) };
}

function summarizeArguments(argumentsValue: JsonObject) {
  const rendered = JSON.stringify(argumentsValue);
  if (rendered === "{}") return undefined;
  return rendered.length > 300 ? `${rendered.slice(0, 297)}...` : rendered;
}

async function startCapture(argumentsValue: JsonObject) {
  const health = await ensureDaemon();
  if (!health.cdp_endpoint) {
    throw new Error("No browser is attached. Call capture_browser_ensure, configure Playwright MCP with its cdpEndpoint, navigate to the target page, then call capture_start.");
  }
  const result = object(await api("POST", "/api/sessions/start", {
    title: optionalString(argumentsValue.title),
    origins: optionalStringArray(argumentsValue.origins),
    captureCanvas: optionalBoolean(argumentsValue.captureCanvas),
  }));
  const sessionId = requiredString(result.sessionId, "Capture session ID");
  const status = await captureStatus();
  return { ...result, cdpEndpoint: status.cdpEndpoint, state: status.state, replayUrl: replayUrl(sessionId) };
}

async function ensureBrowser(argumentsValue: JsonObject) {
  await ensureDaemon();
  const result = object(await api("POST", "/api/browser/ensure", { executable: optionalString(argumentsValue.browserExecutable) }));
  return {
    managed: result.managed === true,
    launched: result.launched === true,
    cdpEndpoint: result.cdp_endpoint,
    browserState: result.browser_state,
    browserConfigState: result.browser_config_state,
    browserConfig: result.browser_config,
    activeBrowserConfig: result.active_browser_config,
  };
}

async function attachBrowser(argumentsValue: JsonObject) {
  const cdpEndpoint = requiredString(argumentsValue.cdpEndpoint, "CDP endpoint");
  await ensureDaemon();
  const result = object(await api("POST", "/api/browser/attach", { cdp_endpoint: cdpEndpoint }));
  return {
    managed: result.managed === true,
    cdpEndpoint: result.cdp_endpoint,
    browserState: result.browser_state,
    browserConfigState: result.browser_config_state,
  };
}

async function addMarker(argumentsValue: JsonObject) {
  const label = requiredString(argumentsValue.label, "Marker label");
  const placement = optionalPlacement(argumentsValue.placement) ?? "after_previous";
  const color = optionalColor(argumentsValue.color);
  await api("POST", "/api/sessions/marker", { label, note: optionalString(argumentsValue.note), placement, ...(color ? { color } : {}) });
  return { ok: true, label, placement, ...(color ? { color } : {}) };
}

async function captureStatus() {
  const health = object(await api("GET", "/health"));
  const replay = health.state === "capture";
  const hasBrowser = typeof health.cdp_endpoint === "string";
  const navigatedPageCount = numberOrZero(health.navigated_page_count);
  return {
    state: replay ? "replay" : hasBrowser ? navigatedPageCount > 0 ? "page_ready" : "browser_ready" : "browser_unavailable",
    cdpEndpoint: health.cdp_endpoint,
    managedBrowser: health.managed_browser === true,
    pageCount: numberOrZero(health.page_count),
    navigatedPageCount,
    browserConfigState: health.browser_config_state,
    browserConfig: health.browser_config,
    activeBrowserConfig: health.active_browser_config,
    replayDefaults: health.replay_defaults,
    configWarnings: health.config_warnings,
    configError: health.config_error,
    viewport: health.viewport,
    replay: replay ? {
      sessionId: health.sessionId,
      elapsedMs: health.elapsedMs,
      segmentCount: numberOrZero(health.segmentCount),
      chunkCount: numberOrZero(health.chunkCount),
      eventCount: numberOrZero(health.eventCount),
    } : null,
  };
}

async function stopCapture(argumentsValue: JsonObject) {
  const result = object(await api("POST", "/api/sessions/stop", {
    outcome: optionalOutcome(argumentsValue.outcome),
    notes: optionalString(argumentsValue.notes),
  }));
  const sessionId = requiredString(result.sessionId, "Capture session ID");
  // Older already-running daemons predate portable_bundle. Export in the MCP as
  // a compatibility fallback so an updated MCP can still publish their session.
  const portableArtifactPath = optionalString(result.portable_bundle) ?? (await exportSession(sessionId)).path;
  // Stopping only saves and previews locally. Sharing is an explicit follow-up
  // through replay_share or the player's Share button.
  return {
    ...result,
    ...(portableArtifactPath ? { portableArtifactPath } : {}),
    replayUrl: replayUrl(sessionId),
    shareAvailable: Boolean(configuredShareEndpoint()),
  };
}

async function shareReplay(argumentsValue: JsonObject) {
  const sessionId = requiredString(argumentsValue.sessionId, "Capture session ID");
  const shareEndpoint = configuredShareEndpoint();
  if (!shareEndpoint) throw new Error("REPLAY_SHARE_URL is not configured for this Replay MCP server.");
  const home = process.env.REPLAY_HOME ?? join(process.env.HOME ?? process.cwd(), ".replay");
  const artifact = join(home, "exports", `${sessionId}.replay`);
  if (!existsSync(artifact)) throw new Error(`Portable artifact ${artifact} was not found. Call capture_stop before replay_share.`);
  const { shareUrl } = await uploadReplay(shareEndpoint, artifact);
  return { sessionId, shareUrl };
}

function configuredShareEndpoint() { return process.env.REPLAY_SHARE_URL?.replace(/\/$/, "") || undefined; }

async function ensureDaemon(): Promise<JsonObject> {
  const running = await probeDaemon();
  if (running.health) return running.health;
  if (running.listening) throw new Error(portConflict());
  if (!existsSync(daemonEntry)) throw new Error("replay is not built. Run pnpm build before starting the MCP server.");
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", cwd: resolve(moduleDirectory, "../../.."), env: { ...process.env, REPLAY_CONFIG_CWD: process.cwd() } });
  child.unref();
  let daemonGone = false;
  child.once("exit", () => { daemonGone = true; });
  child.once("error", () => { daemonGone = true; });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    const probe = await probeDaemon();
    if (probe.health) return probe.health;
    if (probe.listening) throw new Error(portConflict());
    // A daemon that lost a startup race leaves the winner answering health
    // above; an exit with nothing listening means the daemon itself failed.
    if (daemonGone) throw new Error(`The replay daemon exited during startup. Run \`node ${daemonEntry}\` to see why.`);
  }
  throw new Error(`The replay daemon did not respond at ${endpoint} within 2.5s of spawning.`);
}

/**
 * A valid /health body is the only proof a replay daemon owns the endpoint.
 * Anything else answering there is a foreign process: spawning a daemon behind
 * it would die on the taken port, and treating it as the daemon (the old
 * response.ok check did) would misroute replay calls into it.
 */
async function probeDaemon(): Promise<{ health?: JsonObject; listening: boolean }> {
  let response: Response;
  try { response = await fetch(`${endpoint}/health`); } catch { return { listening: false }; }
  const health = object(await response.json().catch(() => undefined));
  return response.ok && health.ok === true ? { health, listening: true } : { listening: true };
}

function portConflict() {
  return `Something that is not a replay daemon is already listening at ${endpoint}. Stop that process or point REPLAY_PORT / REPLAY_DAEMON_URL at a free port.`;
}

type DaemonLease = { id: string; renewTimer: NodeJS.Timeout };

async function acquireDaemonLease() {
  try {
    await ensureDaemon();
    const response = await fetch(`${endpoint}/api/leases/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "replay-mcp", kind: "agent", ttl_ms: 30_000 }),
    });
    const value = await response.json().catch(() => ({})) as { lease_id?: string };
    if (!response.ok || !value.lease_id) return;
    const renewTimer = setInterval(() => void renewDaemonLease(value.lease_id!), 10_000);
    renewTimer.unref();
    daemonLease = { id: value.lease_id, renewTimer };
  } catch {
    // An older daemon does not yet implement leases. It remains compatible and
    // will retain its previous manual lifecycle until it is restarted.
  }
}

async function renewDaemonLease(id: string) {
  try {
    const response = await fetch(`${endpoint}/api/leases/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: id, ttl_ms: 30_000 }),
    });
    if (!response.ok) await releaseDaemonLease();
  } catch { await releaseDaemonLease(); }
}

async function releaseDaemonLease() {
  const lease = daemonLease;
  daemonLease = undefined;
  if (!lease) return;
  clearInterval(lease.renewTimer);
  try {
    await fetch(`${endpoint}/api/leases/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: lease.id }),
      keepalive: true,
    });
  } catch { /* Lease expiry is the fallback when the process disappears. */ }
}

async function api(method: string, path: string, body?: unknown, ensure = true): Promise<unknown> {
  if (ensure) await ensureDaemon();
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return {};
  const parsed = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? response.statusText);
  return parsed;
}

function toolResult(value: JsonObject): JsonObject {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown): JsonObject {
  return { content: [{ type: "text", text: messageOf(error) }], isError: true };
}

function respond(id: Request["id"], result?: JsonObject, error?: { code: number; message: string }) {
  const message = error ? { jsonrpc: "2.0", id: id ?? null, error } : { jsonrpc: "2.0", id: id ?? null, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replayUrl(sessionId: string) { return `${endpoint}/replay?id=${encodeURIComponent(sessionId)}`; }
function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function requiredString(value: Json | undefined, label: string) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value; }
function optionalString(value: Json | undefined) { return typeof value === "string" ? value : undefined; }
function optionalBoolean(value: Json | undefined) { if (value !== undefined && typeof value !== "boolean") throw new Error("Expected a boolean value."); return value; }
function optionalStringArray(value: Json | undefined) { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Origins must be an array of strings."); return value; }
function optionalOutcome(value: Json | undefined) { if (value === undefined) return undefined; if (value === "reproduced" || value === "verified" || value === "other") return value; throw new Error("Outcome must be reproduced, verified, or other."); }
function optionalPlacement(value: Json | undefined) { if (value === undefined || value === "after_previous" || value === "before_next") return value; throw new Error("Marker placement must be after_previous or before_next."); }
function optionalColor(value: Json | undefined) { if (value === undefined || value === "default") return undefined; if (value === "yellow" || value === "green") return value; throw new Error("Marker color must be yellow or green."); }
function numberOrZero(value: Json | undefined) { return typeof value === "number" ? value : 0; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
