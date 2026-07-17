import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("MCP tools make browser setup explicit and preserve ordered marker metadata", async () => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let attached = false;
  const daemon = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
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
    if (request.method === "POST" && path === "/api/browser/ensure") { attached = true; return json(response, { managed: true, launched: true, cdp_endpoint: "http://127.0.0.1:9333", browser_state: "ready" }); }
    if (request.method === "POST" && path === "/api/browser/attach") return json(response, { managed: false, cdp_endpoint: body?.cdp_endpoint, browser_state: "ready" });
    if (request.method === "POST" && path === "/api/sessions/start") return json(response, { sessionId: "rec_test" });
    if (request.method === "POST" && path === "/api/sessions/marker") return empty(response);
    if (request.method === "POST" && path === "/api/sessions/stop") return json(response, { sessionId: "rec_test", path: "/tmp/rec_test", rawDurationMs: 1200, activeDurationMs: 900, markers: [] });
    return json(response, { error: "not found" }, 404);
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  if (!address || typeof address === "string") throw new Error("Fixture daemon did not expose a TCP port.");
  const server = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], { env: { ...process.env, REC_DAEMON_URL: `http://127.0.0.1:${address.port}` } });
  try {
    const client = new McpClient(server);
    const initialized = await client.request("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(initialized.result.serverInfo.name, "rec-mcp");
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["recording_browser_ensure", "recording_attach_browser", "recording_start", "recording_marker", "recording_status", "recording_stop"]);
    const noBrowser = await client.request("tools/call", { name: "recording_start", arguments: { title: "No browser" } });
    assert.equal(noBrowser.result.isError, true);
    assert.match(noBrowser.result.content[0].text, /recording_browser_ensure/);
    assert.equal(calls.filter((call) => call.path === "/api/browser/ensure").length, 0);
    const ensured = await client.request("tools/call", { name: "recording_browser_ensure", arguments: {} });
    assert.match(ensured.result.content[0].text, /9333/);
    const started = await client.request("tools/call", { name: "recording_start", arguments: { title: "MCP fixture" } });
    assert.match(started.result.content[0].text, /rec_test/);
    await client.request("tools/call", { name: "recording_marker", arguments: { label: "Observed issue", placement: "before_next" } });
    const stopped = await client.request("tools/call", { name: "recording_stop", arguments: { outcome: "reproduced" } });
    assert.match(stopped.result.content[0].text, /replayUrl/);
    const status = await client.request("tools/call", { name: "recording_status", arguments: {} });
    assert.match(status.result.content[0].text, /page_ready/);
    const external = await client.request("tools/call", { name: "recording_attach_browser", arguments: { cdpEndpoint: "http://127.0.0.1:9222" } });
    assert.match(external.result.content[0].text, /9222/);
    assert.equal(calls.filter((call) => call.path === "/api/browser/ensure").length, 1);
    assert.equal(calls.filter((call) => call.path === "/api/sessions/start").length, 1);
    assert.deepEqual(calls.find((call) => call.path === "/api/sessions/marker")?.body, { label: "Observed issue", placement: "before_next" });
  } finally {
    server.kill();
    daemon.close();
    await once(daemon, "close");
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
