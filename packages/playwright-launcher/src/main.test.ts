import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("launcher forwards stdio transparently and provisions Rec's browser only on the first tool call", async () => {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const daemon = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    calls.push({ path: request.url ?? "/", body });
    if (request.method === "GET" && request.url === "/health") return json(response, { ok: true });
    if (request.method === "POST" && request.url === "/api/leases/acquire") return json(response, { lease_id: "launcher-lease" }, 201);
    if (request.method === "POST" && request.url === "/api/leases/release") return json(response, { released: true });
    if (request.method === "POST" && request.url === "/api/browser/ensure") return json(response, { cdp_endpoint: "http://127.0.0.1:9333" });
    return json(response, { error: "not found" }, 404);
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  if (!address || typeof address === "string") throw new Error("Fixture daemon did not expose a port.");
  const launcher = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "main.js")], {
    env: {
      ...process.env,
      REC_DAEMON_URL: `http://127.0.0.1:${address.port}`,
      REC_PLAYWRIGHT_MCP_COMMAND: process.execPath,
      REC_PLAYWRIGHT_MCP_ARGS: JSON.stringify(["-e", "process.stdin.pipe(process.stdout)", "--"]),
    },
  });
  let output = "";
  launcher.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const waitFor = async (predicate: () => boolean, message: string) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) { if (predicate()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(message);
  };
  try {
    // The MCP handshake is forwarded untouched and must not launch Chrome.
    launcher.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitFor(() => output.includes("\"method\":\"initialize\""), "Launcher did not forward the handshake to Playwright MCP.");
    assert.equal(calls.some((call) => call.path === "/api/browser/ensure"), false, "startup and handshake must not provision the browser");

    // The first tools/call provisions the managed browser before it is forwarded.
    launcher.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })}\n`);
    await waitFor(() => calls.some((call) => call.path === "/api/browser/ensure"), "First tool call did not provision Rec's browser.");
    await waitFor(() => output.includes("\"method\":\"tools/call\""), "Launcher did not forward the tool call after provisioning.");
    assert.deepEqual(calls.map((call) => call.path), ["/health", "/api/leases/acquire", "/api/browser/ensure"]);
  } finally {
    launcher.kill();
    daemon.close();
    await once(daemon, "close");
  }
});

function json(response: import("node:http").ServerResponse, value: unknown, status = 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
