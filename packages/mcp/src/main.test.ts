import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportSession, SessionStore } from "@replay/core";

test("MCP tools make browser setup explicit and preserve ordered marker metadata", async () => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let attached = false;
  const replayHome = await mkdtemp(join(tmpdir(), "replay-mcp-share-"));
  await mkdir(join(replayHome, "sessions", "replay_test"), { recursive: true });
  await writeFile(join(replayHome, "sessions", "replay_test", "manifest.json"), JSON.stringify({
    format_version: 1,
    id: "replay_test",
    title: "MCP fixture",
    created_at: new Date().toISOString(),
    capture: { version: "0.1.0", rrweb: "2.0.0-alpha.20", capture_canvas: false, capture_cross_origin_iframes: false },
    origins: [],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [],
    assets: [],
    markers: [],
  }));
  // A real portable bundle, built in its own home so replay_fetch performs a
  // genuine import into the MCP child's REPLAY_HOME rather than a reuse hit.
  const shareId = "0123456789abcdef01234567";
  const bundleHome = await mkdtemp(join(tmpdir(), "replay-mcp-bundle-"));
  const previousHome = process.env.REPLAY_HOME;
  let bundleBytes: Buffer;
  try {
    process.env.REPLAY_HOME = bundleHome;
    const store = await SessionStore.create({
      format_version: 1, id: "replay_fetched", title: "Fetched fixture", created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false }, origins: ["http://fixture.test"], masking: { mask_all_inputs: false, passwords: true }, segments: [], tab_events: [], markers: [], assets: [],
    });
    store.segment("seg_1", "http://fixture.test", 0);
    await store.append("seg_1", [{ type: 2, timestamp: 1 }], Date.now());
    await store.finalize();
    bundleBytes = await readFile((await exportSession("replay_fetched")).path);
  } finally {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
  }
  const daemon = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body: Record<string, unknown> | undefined;
    if (raw) {
      try { body = JSON.parse(raw) as Record<string, unknown>; }
      catch { /* The share endpoint accepts the binary .replay bundle. */ }
    }
    calls.push({ method: request.method ?? "", path, body });
    if (request.method === "GET" && path === "/health") return json(response, {
      ok: true,
      state: "idle",
      cdp_endpoint: attached ? "http://127.0.0.1:9333" : undefined,
      managed_browser: attached,
      browser_state: attached ? "ready" : "unavailable",
      page_count: attached ? 1 : 0,
      navigated_page_count: attached ? 1 : 0,
    });
    if (request.method === "POST" && path === "/api/leases/acquire") return json(response, { lease_id: "mcp-lease" }, 201);
    if (request.method === "POST" && path === "/api/leases/renew") return json(response, { lease_id: "mcp-lease" });
    if (request.method === "POST" && path === "/api/leases/release") return json(response, { released: true });
    if (request.method === "POST" && path === "/api/browser/ensure") { attached = true; return json(response, { managed: true, launched: true, cdp_endpoint: "http://127.0.0.1:9333", browser_state: "ready" }); }
    if (request.method === "POST" && path === "/api/browser/attach") return json(response, { managed: false, cdp_endpoint: body?.cdp_endpoint, browser_state: "ready" });
    if (request.method === "POST" && path === "/api/sessions/start") return json(response, { sessionId: "replay_test" });
    if (request.method === "POST" && path === "/api/sessions/marker") return empty(response);
    if (request.method === "POST" && path === "/api/sessions/stop") return json(response, { sessionId: "replay_test", path: "/tmp/replay_test", rawDurationMs: 1200, activeDurationMs: 900, markers: [] });
    if (request.method === "POST" && path === "/v1/replays") return json(response, { shareUrl: "https://share.fixture/r/abc123" }, 201);
    // The same fixture doubles as the remote share server for the read tools.
    if (request.method === "GET" && path === `/r/${shareId}.md`) { response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); response.end("Replay: Fetched fixture\n- [0:00] Opened http://fixture.test\n"); return; }
    if (request.method === "GET" && path.startsWith(`/v1/replays/${shareId}/steps`)) return json(response, { from_ms: 0, to_ms: 5000, steps: [{ t_ms: 0, kind: "page", description: "Opened http://fixture.test" }] });
    if (request.method === "GET" && path === `/v1/replays/${shareId}/bundle`) { response.writeHead(200, { "content-type": "application/vnd.replay" }); response.end(bundleBytes); return; }
    return json(response, { error: "not found" }, 404);
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  if (!address || typeof address === "string") throw new Error("Fixture daemon did not expose a TCP port.");
  // Embedded Playwright is exercised by its own test below; this one pins the
  // replay tool surface and the escape hatch that disables embedding.
  const server = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], { env: { ...process.env, REPLAY_HOME: replayHome, REPLAY_DAEMON_URL: `http://127.0.0.1:${address.port}`, REPLAY_SHARE_URL: `http://127.0.0.1:${address.port}`, REPLAY_EMBEDDED_PLAYWRIGHT: "0" } });
  try {
    const client = new McpClient(server);
    const initialized = await client.request("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(initialized.result.serverInfo.name, "replay-mcp");
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["capture_browser_ensure", "capture_attach_browser", "capture_start", "capture_marker", "capture_highlight", "capture_status", "capture_stop", "replay_share", "replay_overview", "replay_steps", "replay_fetch", "replay_review"]);
    const noBrowser = await client.request("tools/call", { name: "capture_start", arguments: { title: "No browser" } });
    assert.equal(noBrowser.result.isError, true);
    assert.match(noBrowser.result.content[0].text, /capture_browser_ensure/);
    assert.equal(calls.filter((call) => call.path === "/api/browser/ensure").length, 0);
    const ensured = await client.request("tools/call", { name: "capture_browser_ensure", arguments: {} });
    assert.match(ensured.result.content[0].text, /9333/);
    const started = await client.request("tools/call", { name: "capture_start", arguments: { title: "MCP fixture" } });
    assert.match(started.result.content[0].text, /replay_test/);
    await client.request("tools/call", { name: "capture_marker", arguments: { label: "Observed issue", placement: "before_next" } });
    await client.request("tools/call", { name: "capture_marker", arguments: { label: "Green checkpoint", color: "green" } });
    const badColor = await client.request("tools/call", { name: "capture_marker", arguments: { label: "Bad", color: "blue" } });
    assert.equal(badColor.result.isError, true);
    const stopped = await client.request("tools/call", { name: "capture_stop", arguments: { outcome: "reproduced" } });
    assert.match(stopped.result.content[0].text, /replayUrl/);
    assert.match(stopped.result.content[0].text, /portableArtifactPath/);
    // Stopping saves locally and does not upload. Sharing is a separate, explicit step.
    assert.doesNotMatch(stopped.result.content[0].text, /shareUrl/);
    assert.equal(calls.some((call) => call.path === "/v1/replays"), false);
    assert.equal(existsSync(join(replayHome, "exports", "replay_test.replay")), true);
    const shared = await client.request("tools/call", { name: "replay_share", arguments: { sessionId: "replay_test" } });
    assert.match(shared.result.content[0].text, /https:\/\/share\.fixture\/r\/abc123/);
    assert.equal(calls.filter((call) => call.path === "/v1/replays").length, 1);
    // The remote-read tools take the share link as pasted and derive the query
    // endpoints from it; no REPLAY_SHARE_URL is involved in reading.
    const shareLink = `http://127.0.0.1:${address.port}/r/${shareId}`;
    const overview = await client.request("tools/call", { name: "replay_overview", arguments: { url: shareLink } });
    assert.match(overview.result.content[0].text, /Fetched fixture/);
    const steps = await client.request("tools/call", { name: "replay_steps", arguments: { url: shareLink, marker: "Bug", window_ms: 5000 } });
    assert.match(steps.result.content[0].text, /Opened http:\/\/fixture\.test/);
    const stepsCall = calls.find((call) => call.path.includes("/steps"));
    assert.match(String(stepsCall?.path), /marker=Bug/);
    assert.match(String(stepsCall?.path), /window_ms=5000/);
    const badUrl = await client.request("tools/call", { name: "replay_overview", arguments: { url: "https://example.test/not-a-share" } });
    assert.equal(badUrl.result.isError, true);
    assert.match(badUrl.result.content[0].text, /not a replay share link/);
    const fetched = await client.request("tools/call", { name: "replay_fetch", arguments: { url: shareLink } });
    assert.match(fetched.result.content[0].text, /replay_fetched/);
    assert.match(fetched.result.content[0].text, /replayUrl/);
    assert.equal(existsSync(join(replayHome, "sessions", "replay_fetched", "manifest.json")), true);
    const status = await client.request("tools/call", { name: "capture_status", arguments: {} });
    assert.match(status.result.content[0].text, /page_ready/);
    const external = await client.request("tools/call", { name: "capture_attach_browser", arguments: { cdpEndpoint: "http://127.0.0.1:9222" } });
    assert.match(external.result.content[0].text, /9222/);
    assert.equal(calls.filter((call) => call.path === "/api/browser/ensure").length, 1);
    assert.equal(calls.filter((call) => call.path === "/api/sessions/start").length, 1);
    assert.deepEqual(calls.find((call) => call.path === "/api/sessions/marker")?.body, { label: "Observed issue", placement: "before_next" });
    assert.deepEqual(calls.filter((call) => call.path === "/api/sessions/marker").at(-1)?.body, { label: "Green checkpoint", placement: "after_previous", color: "green" });
  } finally {
    server.kill();
    daemon.close();
    await once(daemon, "close");
    await rm(replayHome, { recursive: true, force: true });
    await rm(bundleHome, { recursive: true, force: true });
  }
});

test("embedded browser tools carry replay_marker and bind markers to actions atomically", async () => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let attached = false;
  let replay = false;
  const fixtureDir = await mkdtemp(join(tmpdir(), "replay-mcp-embedded-"));
  const fakeModule = join(fixtureDir, "fake-playwright-mcp.mjs");
  await writeFile(fakeModule, FAKE_PLAYWRIGHT_MCP);
  const daemon = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    calls.push({ method: request.method ?? "", path, body });
    if (request.method === "GET" && path === "/health") return json(response, {
      ok: true,
      state: replay ? "replay" : "idle",
      cdp_endpoint: attached ? "http://127.0.0.1:9333" : undefined,
      managed_browser: attached,
      browser_state: attached ? "ready" : "unavailable",
      page_count: attached ? 1 : 0,
      navigated_page_count: attached ? 1 : 0,
    });
    if (request.method === "POST" && path.startsWith("/api/leases/")) return json(response, { lease_id: "mcp-lease" }, path.endsWith("acquire") ? 201 : 200);
    if (request.method === "POST" && path === "/api/browser/ensure") { attached = true; return json(response, { managed: true, launched: true, cdp_endpoint: "http://127.0.0.1:9333", browser_state: "ready" }); }
    if (request.method === "POST" && path === "/api/sessions/start") { replay = true; return json(response, { sessionId: "replay_embedded" }); }
    if (request.method === "POST" && path === "/api/sessions/action") return json(response, { captured: replay });
    return json(response, { error: "not found" }, 404);
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  if (!address || typeof address === "string") throw new Error("Fixture daemon did not expose a TCP port.");
  const server = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], {
    env: { ...process.env, REPLAY_DAEMON_URL: `http://127.0.0.1:${address.port}`, REPLAY_EMBEDDED_MCP_MODULE: fakeModule },
  });
  try {
    const client = new McpClient(server);
    await client.request("initialize", { protocolVersion: "2025-03-26" });

    const listed = await client.request("tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("capture_start"));
    assert.ok(names.includes("browser_navigate"));
    assert.ok(names.includes("browser_click"));
    const navigate = listed.result.tools.find((tool: { name: string }) => tool.name === "browser_navigate");
    assert.equal(navigate.inputSchema.properties.replay_marker.required[0], "label");
    const captureStart = listed.result.tools.find((tool: { name: string }) => tool.name === "capture_start");
    assert.equal(captureStart.inputSchema.properties.replay_marker, undefined);

    // Before any replay: the action still runs, replay_marker is stripped from
    // what Playwright sees, and the dropped marker surfaces as a warning.
    const early = await client.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.test/", replay_marker: { label: "too early" } } });
    const earlyEcho = JSON.parse(early.result.content[0].text);
    assert.deepEqual(earlyEcho.args, { url: "https://example.test/" });
    assert.equal(earlyEcho.cdpEndpoint, "http://127.0.0.1:9333");
    assert.match(early.result.content[1].text, /no replay is active/);
    assert.equal(calls.filter((call) => call.path === "/api/browser/ensure").length, 1);

    await client.request("tools/call", { name: "capture_start", arguments: { title: "Embedded" } });
    const marked = await client.request("tools/call", { name: "browser_click", arguments: { selector: "#submit", replay_marker: { label: "Submitted form", note: "confirmed", color: "green" } } });
    assert.equal(marked.result.content.length, 1);
    const markedEcho = JSON.parse(marked.result.content[0].text);
    assert.deepEqual(markedEcho.args, { selector: "#submit" });

    const plain = await client.request("tools/call", { name: "browser_click", arguments: { selector: "#other" } });
    assert.equal(plain.result.content.length, 1);

    // A malformed marker fails loudly before the browser action executes.
    const invalid = await client.request("tools/call", { name: "browser_click", arguments: { selector: "#x", replay_marker: { note: "missing label" } } });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /replay_marker label/);

    const actions = calls.filter((call) => call.path === "/api/sessions/action");
    assert.equal(actions.length, 3);
    for (const action of actions) {
      assert.match(String(action.body?.id), /^act_/);
      assert.ok(Number(action.body?.started_at_epoch_ms) <= Number(action.body?.finished_at_epoch_ms));
      assert.equal(action.body?.ok, true);
    }
    assert.deepEqual(actions[0]?.body?.marker, { label: "too early" });
    assert.deepEqual(actions[1]?.body?.marker, { label: "Submitted form", note: "confirmed", color: "green" });
    assert.equal(actions[1]?.body?.tool, "browser_click");
    assert.match(String(actions[1]?.body?.args_summary), /#submit/);
    assert.doesNotMatch(String(actions[1]?.body?.args_summary), /replay_marker/);
    assert.equal(actions[2]?.body?.marker, undefined);
  } finally {
    server.kill();
    daemon.close();
    await once(daemon, "close");
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("review warnings surface in tool results and replay_review reads the just-stopped session", async () => {
  const replayHome = await mkdtemp(join(tmpdir(), "replay-mcp-review-"));
  const daemon = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "GET" && path === "/health") return json(response, { ok: true, state: "capture", cdp_endpoint: "http://127.0.0.1:9333", managed_browser: true, browser_state: "ready", page_count: 1, navigated_page_count: 1 });
    if (request.method === "POST" && path.startsWith("/api/leases/")) return json(response, { lease_id: "mcp-lease" }, path.endsWith("acquire") ? 201 : 200);
    if (request.method === "POST" && path === "/api/browser/ensure") return json(response, { managed: true, launched: true, cdp_endpoint: "http://127.0.0.1:9333", browser_state: "ready" });
    if (request.method === "POST" && path === "/api/sessions/start") return json(response, { sessionId: "replay_review_test", startWarning: { code: "opens_on_auth_page", severity: "warn", message: "Capture started on an auth/setup screen (https://app.example.com/login).", hint: "Navigate to the feature first." } });
    if (request.method === "POST" && path === "/api/sessions/highlight") return json(response, { node_id: null });
    if (request.method === "POST" && path === "/api/sessions/stop") return json(response, { sessionId: "replay_review_test", reviewFindings: [{ code: "no_resolved_defect_highlight", severity: "error", message: "No defect highlight resolved to an element on the page.", hint: "Call capture_highlight at the defect." }], portable_bundle: join(replayHome, "exports", "replay_review_test.replay") });
    if (request.method === "GET" && path === "/api/sessions/latest") return json(response, { sessionId: "replay_review_test" });
    if (request.method === "GET" && path === "/api/sessions/replay_review_test/review") return json(response, { summary_text: "Replay: Review fixture\n- [0:00] Opened the feature", findings: [{ code: "no_resolved_defect_highlight", severity: "error", message: "No defect highlight resolved.", hint: "Call capture_highlight." }] });
    return json(response, { error: "not found" }, 404);
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  if (!address || typeof address === "string") throw new Error("Fixture daemon did not expose a TCP port.");
  const server = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], { env: { ...process.env, REPLAY_HOME: replayHome, REPLAY_DAEMON_URL: `http://127.0.0.1:${address.port}`, REPLAY_EMBEDDED_PLAYWRIGHT: "0" } });
  try {
    const client = new McpClient(server);
    await client.request("initialize", { protocolVersion: "2025-03-26" });
    await client.request("tools/call", { name: "capture_browser_ensure", arguments: {} });
    const started = await client.request("tools/call", { name: "capture_start", arguments: { title: "Review fixture" } });
    assert.equal(started.result.content.length, 2, "the start warning is appended as a second content block");
    assert.match(started.result.content[1].text, /opens_on_auth_page/);
    const highlighted = await client.request("tools/call", { name: "capture_highlight", arguments: { element: { text: "1 of 3" }, defect: { expected: "Step 2 of 3", actual: "1 of 3" } } });
    assert.equal(highlighted.result.content.length, 2, "an unresolved defect highlight appends a warning");
    assert.match(highlighted.result.content[0].text, /"resolved": false/);
    assert.match(highlighted.result.content[1].text, /did not resolve/);
    const stopped = await client.request("tools/call", { name: "capture_stop", arguments: { outcome: "reproduced" } });
    assert.equal(stopped.result.content.length, 2, "review findings are appended as warnings on stop");
    assert.match(stopped.result.content[1].text, /no_resolved_defect_highlight/);
    const reviewed = await client.request("tools/call", { name: "replay_review", arguments: {} });
    assert.match(reviewed.result.content[0].text, /Review fixture/);
    assert.match(reviewed.result.content[0].text, /no_resolved_defect_highlight/);
  } finally {
    server.kill();
    daemon.close();
    await once(daemon, "close");
    await rm(replayHome, { recursive: true, force: true });
  }
});

/**
 * A stand-in for @playwright/mcp's createConnection: same wire behavior over
 * the same transport contract, minus any real browser. Tool calls echo their
 * arguments so tests can assert exactly what Playwright would have received.
 */
const FAKE_PLAYWRIGHT_MCP = `
export async function createConnection(config) {
  return {
    async connect(transport) {
      transport.onmessage = (message) => {
        if (message.method === "initialize") {
          void transport.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-playwright", version: "0.0.0" } } });
        } else if (message.method === "tools/list") {
          void transport.send({ jsonrpc: "2.0", id: message.id, result: { tools: [
            { name: "browser_navigate", description: "Navigate to a URL", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false } },
            { name: "browser_click", description: "Click an element", inputSchema: { type: "object", properties: { selector: { type: "string" } }, additionalProperties: false } },
          ] } });
        } else if (message.method === "tools/call") {
          const text = JSON.stringify({ name: message.params.name, args: message.params.arguments, cdpEndpoint: config?.browser?.cdpEndpoint });
          void transport.send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
        } else if (message.id !== undefined && message.id !== null) {
          void transport.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
        }
      };
      void transport.start();
    },
    async close() {},
  };
}
`;

test("a foreign process on the daemon endpoint fails fast with a conflict error instead of a blind spawn", async () => {
  // Worst case: the squatter answers 200 with JSON on every path. A connection
  // refusal already takes the spawn path; this must neither be mistaken for a
  // healthy daemon nor trigger a doomed daemon spawn behind it.
  const squatter = createServer((_, response) => json(response, { hello: "world" }));
  squatter.listen(0, "127.0.0.1");
  await once(squatter, "listening");
  const address = squatter.address();
  if (!address || typeof address === "string") throw new Error("Fixture squatter did not expose a TCP port.");
  const server = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], { env: { ...process.env, REPLAY_DAEMON_URL: `http://127.0.0.1:${address.port}` } });
  try {
    const client = new McpClient(server);
    await client.request("initialize", { protocolVersion: "2025-03-26" });
    const status = await client.request("tools/call", { name: "capture_status", arguments: {} });
    assert.equal(status.result.isError, true);
    assert.match(status.result.content[0].text, /not a replay daemon/);
    assert.match(status.result.content[0].text, new RegExp(`127\\.0\\.0\\.1:${address.port}`));
  } finally {
    server.kill();
    squatter.close();
    await once(squatter, "close");
  }
});

class McpClient {
  private readonly lines;
  private nextId = 1;
  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: process.stdout });
  }
  async request(method: string, params: unknown): Promise<{ result: any }> {
    const line = once(this.lines, "line") as Promise<[string]>;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params })}\n`);
    return JSON.parse((await line)[0]) as { result: any };
  }
}

function json(response: import("node:http").ServerResponse, value: unknown, status = 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
function empty(response: import("node:http").ServerResponse) { response.writeHead(204); response.end(); }
