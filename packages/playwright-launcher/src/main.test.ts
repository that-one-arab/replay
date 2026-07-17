import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("launcher ensures Rec's browser before transparently starting Playwright MCP", async () => {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let markEnsured!: () => void;
  const ensured = new Promise<void>((resolveEnsured) => { markEnsured = resolveEnsured; });
  const daemon = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    calls.push({ path: request.url ?? "/", body });
    if (request.method === "GET" && request.url === "/health") return json(response, { ok: true });
    if (request.method === "POST" && request.url === "/api/browser/ensure") { markEnsured(); return json(response, { cdp_endpoint: "http://127.0.0.1:9333" }); }
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
  try {
    const echoed = once(launcher.stdout, "data") as Promise<[Buffer]>;
    await ensured;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    launcher.stdin.write("playwright-mcp-stdio\n");
    const result = await Promise.race([
      echoed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Launcher did not forward stdio to Playwright MCP.")), 2_000)),
    ]);
    assert.equal(result[0].toString(), "playwright-mcp-stdio\n");
    assert.deepEqual(calls.map((call) => call.path), ["/health", "/api/browser/ensure"]);
  } finally {
    launcher.kill();
    daemon.close();
    await once(daemon, "close");
  }
});

function json(response: import("node:http").ServerResponse, value: unknown, status = 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
