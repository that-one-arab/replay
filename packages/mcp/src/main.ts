#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { exportSession } from "@signit/rec-core";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const endpoint = process.env.REC_DAEMON_URL ?? "http://127.0.0.1:7717";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = process.env.REC_DAEMON_ENTRY ?? resolve(moduleDirectory, "../../daemon/dist/main.js");

const tools: JsonObject[] = [
  {
    name: "recording_browser_ensure",
    description: "Ensure Rec's dedicated local Chrome is running and return the CDP endpoint that Playwright MCP must use.",
    inputSchema: {
      type: "object",
      properties: {
        browserExecutable: { type: "string", description: "Optional Chrome executable for Rec to launch." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recording_attach_browser",
    description: "Attach Rec to an explicitly supplied loopback Chrome CDP endpoint. Do not call while recording.",
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
    name: "recording_start",
    description: "Start capture on an attached browser after Playwright MCP has navigated to an in-scope page.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable recording title." },
        origins: { type: "array", items: { type: "string" }, description: "Optional allowed page origins. Defaults to the active page origin." },
        recordCanvas: { type: "boolean", description: "Capture canvas mutations. Disabled by default." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recording_marker",
    description: "Add a labelled checkpoint to the active recording.",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string", description: "Short checkpoint label." },
        note: { type: "string", description: "Optional context for the checkpoint." },
        placement: { type: "string", enum: ["after_previous", "before_next"], description: "Narrative placement relative to ordered Playwright actions. Defaults to after_previous." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recording_status",
    description: "Read local recorder and browser attachment status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "recording_stop",
    description: "Stop the active recording and return its local replay handoff. When REC_SHARE_URL is configured, automatically publish its portable artifact and return the share URL.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["reproduced", "verified", "other"], description: "Optional recording outcome." },
        notes: { type: "string", description: "Optional handoff notes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recording_share",
    description: "Explicitly upload a completed portable recording to the configured Rec share service and return its public bearer link.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string", description: "Completed recording ID returned by recording_stop." } },
      additionalProperties: false,
    },
  },
];

void run();

async function run() {
  let buffered = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) queue = queue.then(() => handleLine(line));
  });
  process.stdin.on("end", () => { if (buffered.trim()) void handleLine(buffered); });
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
      serverInfo: { name: "rec-mcp", version: "0.1.0" },
    };
  }
  if (method === "notifications/initialized") return {};
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
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
      case "recording_browser_ensure": return toolResult(await ensureBrowser(argumentsValue));
      case "recording_attach_browser": return toolResult(await attachBrowser(argumentsValue));
      case "recording_start": return toolResult(await startRecording(argumentsValue));
      case "recording_marker": return toolResult(await addMarker(argumentsValue));
      case "recording_status": return toolResult(await recordingStatus());
      case "recording_stop": return toolResult(await stopRecording(argumentsValue));
      case "recording_share": return toolResult(await shareRecording(argumentsValue));
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toolError(error);
  }
}

async function startRecording(argumentsValue: JsonObject) {
  const health = await ensureDaemon();
  if (!health.cdp_endpoint) {
    throw new Error("No browser is attached. Call recording_browser_ensure, configure Playwright MCP with its cdpEndpoint, navigate to the target page, then call recording_start.");
  }
  const result = object(await api("POST", "/api/sessions/start", {
    title: optionalString(argumentsValue.title),
    origins: optionalStringArray(argumentsValue.origins),
    recordCanvas: optionalBoolean(argumentsValue.recordCanvas),
  }));
  const sessionId = requiredString(result.sessionId, "Recorder session ID");
  const status = await recordingStatus();
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
  };
}

async function addMarker(argumentsValue: JsonObject) {
  const label = requiredString(argumentsValue.label, "Marker label");
  const placement = optionalPlacement(argumentsValue.placement) ?? "after_previous";
  await api("POST", "/api/sessions/marker", { label, note: optionalString(argumentsValue.note), placement });
  return { ok: true, label, placement };
}

async function recordingStatus() {
  const health = object(await api("GET", "/health"));
  const recording = health.state === "recording";
  const hasBrowser = typeof health.cdp_endpoint === "string";
  const navigatedPageCount = numberOrZero(health.navigated_page_count);
  return {
    state: recording ? "recording" : hasBrowser ? navigatedPageCount > 0 ? "page_ready" : "browser_ready" : "browser_unavailable",
    cdpEndpoint: health.cdp_endpoint,
    managedBrowser: health.managed_browser === true,
    pageCount: numberOrZero(health.page_count),
    navigatedPageCount,
    recording: recording ? {
      sessionId: health.sessionId,
      elapsedMs: health.elapsedMs,
      segmentCount: numberOrZero(health.segmentCount),
      chunkCount: numberOrZero(health.chunkCount),
      eventCount: numberOrZero(health.eventCount),
    } : null,
  };
}

async function stopRecording(argumentsValue: JsonObject) {
  const result = object(await api("POST", "/api/sessions/stop", {
    outcome: optionalOutcome(argumentsValue.outcome),
    notes: optionalString(argumentsValue.notes),
  }));
  const sessionId = requiredString(result.sessionId, "Recorder session ID");
  // Older already-running daemons predate portable_bundle. Export in the MCP as
  // a compatibility fallback so an updated MCP can still publish their session.
  const portableArtifactPath = optionalString(result.portable_bundle) ?? (await exportSession(sessionId)).path;
  let shareUrl: string | undefined;
  let shareError: string | undefined;
  const shareEndpoint = configuredShareEndpoint();
  if (portableArtifactPath && shareEndpoint) {
    try { shareUrl = await uploadArtifact(sessionId, portableArtifactPath, shareEndpoint); }
    catch (error) { shareError = messageOf(error); }
  }
  return {
    ...result,
    ...(portableArtifactPath ? { portableArtifactPath } : {}),
    ...(shareUrl ? { shareUrl } : {}),
    ...(shareError ? { shareError } : {}),
    replayUrl: replayUrl(sessionId),
  };
}

async function shareRecording(argumentsValue: JsonObject) {
  const sessionId = requiredString(argumentsValue.sessionId, "Recorder session ID");
  const shareEndpoint = configuredShareEndpoint();
  if (!shareEndpoint) throw new Error("REC_SHARE_URL is not configured for this Rec MCP server.");
  const home = process.env.REC_HOME ?? join(process.env.HOME ?? process.cwd(), ".rec");
  const artifact = join(home, "exports", `${sessionId}.rec`);
  if (!existsSync(artifact)) throw new Error(`Portable artifact ${artifact} was not found. Call recording_stop before recording_share.`);
  return { sessionId, shareUrl: await uploadArtifact(sessionId, artifact, shareEndpoint) };
}

function configuredShareEndpoint() { return process.env.REC_SHARE_URL?.replace(/\/$/, "") || undefined; }
async function uploadArtifact(sessionId: string, artifact: string, shareEndpoint: string) {
  const response = await fetch(`${shareEndpoint}/v1/recordings`, { method: "POST", headers: { "content-type": "application/vnd.rec" }, body: await readFile(artifact) });
  const result = object(await response.json().catch(() => ({})));
  if (!response.ok) throw new Error(optionalString(result.error) ?? response.statusText);
  return requiredString(result.shareUrl, `Share URL for ${sessionId}`);
}

async function ensureDaemon(): Promise<JsonObject> {
  try { return object(await api("GET", "/health", undefined, false)); } catch { /* start below */ }
  if (!existsSync(daemonEntry)) throw new Error("rec is not built. Run pnpm build before starting the MCP server.");
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", cwd: resolve(moduleDirectory, "../../..") });
  child.unref();
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    try { return object(await api("GET", "/health", undefined, false)); } catch (error) { lastError = error; }
  }
  throw new Error(`rec daemon did not start: ${messageOf(lastError)}`);
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
function numberOrZero(value: Json | undefined) { return typeof value === "number" ? value : 0; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
