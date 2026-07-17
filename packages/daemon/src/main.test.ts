import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("daemon reports an unattached browser and rejects unsafe or premature capture requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-daemon-"));
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REC_HOME: home, REC_PORT: String(port) },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(endpoint);
    assert.equal(health.browser_state, "unavailable");
    assert.equal(health.page_count, 0);

    const start = await request(endpoint, "/api/sessions/start", {});
    assert.equal(start.status, 500);
    assert.match(String(start.body.error), /No browser attached/);

    const remoteAttach = await request(endpoint, "/api/browser/attach", { cdp_endpoint: "http://example.test:9222" });
    assert.equal(remoteAttach.status, 500);
    assert.match(String(remoteAttach.body.error), /Only loopback CDP endpoints/);

    const unavailableAttach = await request(endpoint, "/api/browser/attach", { cdp_endpoint: "http://127.0.0.1:1" });
    assert.equal(unavailableAttach.status, 500);
    assert.match(String(unavailableAttach.body.error), /127\.0\.0\.1:1/);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a fixture port.");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForHealth(endpoint: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) return await response.json() as { browser_state?: string; page_count?: number };
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Fixture daemon did not start: ${String(lastError)}`);
}

async function request(endpoint: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { error?: string } };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
}
