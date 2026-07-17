import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("MCP lifecycle tools launch a browser only when the daemon has no attachment", async () => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let attached = false;
  const daemon = createServer(async (request, response) => {
    const path = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    calls.push({ method: request.method ?? "", path, body });
    if (request.method === "GET" && path === "/health") return json(response, { ok: true, state: "idle", cdp_endpoint: attached ? "http://127.0.0.1:9333" : undefined });
    if (request.method === "POST" && path === "/api/browser/start") { attached = true; return json(response, { started: true, cdp_endpoint: "http://127.0.0.1:9333" }); }
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
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["recording_start", "recording_marker", "recording_status", "recording_stop"]);
    const started = await client.request("tools/call", { name: "recording_start", arguments: { title: "MCP fixture" } });
    assert.match(started.result.content[0].text, /rec_test/);
    await client.request("tools/call", { name: "recording_marker", arguments: { label: "Observed issue" } });
    const stopped = await client.request("tools/call", { name: "recording_stop", arguments: { outcome: "reproduced" } });
    assert.match(stopped.result.content[0].text, /replayUrl/);
    await client.request("tools/call", { name: "recording_start", arguments: { title: "Reuse browser" } });
    assert.equal(calls.filter((call) => call.path === "/api/browser/start").length, 1);
    assert.equal(calls.filter((call) => call.path === "/api/sessions/start").length, 2);
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
