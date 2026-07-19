import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("replay leases keep the daemon alive while agent leases control browser ownership", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-daemon-leases-"));
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REC_HOME: home, REC_PORT: String(port), REC_BROWSER_IDLE_TIMEOUT_MS: "1000", REC_DAEMON_IDLE_TIMEOUT_MS: "1000" },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(endpoint);
    const agent = await request(endpoint, "/api/leases/acquire", { owner: "agent-test", kind: "agent", ttl_ms: 5_000 }) as { status: number; body: { lease_id?: string } };
    assert.equal(agent.status, 201);
    assert.ok(agent.body.lease_id);
    const withAgent = await waitForHealth(endpoint) as { leases?: { agent_lease_count?: number; replay_lease_count?: number } };
    assert.equal(withAgent.leases?.agent_lease_count, 1);
    const releasedAgent = await request(endpoint, "/api/leases/release", { lease_id: agent.body.lease_id });
    assert.equal(releasedAgent.status, 200);
    const replay = await request(endpoint, "/api/leases/acquire", { owner: "player-test", kind: "replay", ttl_ms: 5_000 }) as { status: number; body: { lease_id?: string } };
    assert.equal(replay.status, 201);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_150));
    const withReplay = await waitForHealth(endpoint) as { leases?: { agent_lease_count?: number; replay_lease_count?: number } };
    assert.equal(withReplay.leases?.agent_lease_count, 0);
    assert.equal(withReplay.leases?.replay_lease_count, 1);
    await request(endpoint, "/api/leases/release", { lease_id: replay.body.lease_id });
    await waitForExit(daemon);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("closing the managed browser shuts the daemon down even while agent leases persist", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-daemon-browser-close-"));
  // A quiet long-lived process stands in for the managed Chrome; a pre-existing
  // browser.json makes the daemon adopt its pid at startup.
  const fakeBrowser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  await writeFile(join(home, "browser.json"), JSON.stringify({ pid: fakeBrowser.pid, cdp_endpoint: "http://127.0.0.1:1" }) + "\n");
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    // Idle timeouts far beyond the test window prove any exit comes from the
    // browser-close path, not the idle timers.
    env: { ...process.env, REC_HOME: home, REC_PORT: String(port), REC_BROWSER_IDLE_TIMEOUT_MS: "600000", REC_DAEMON_IDLE_TIMEOUT_MS: "600000" },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(endpoint) as { managed_browser?: boolean };
    assert.equal(health.managed_browser, true);
    const agent = await request(endpoint, "/api/leases/acquire", { owner: "agent-test", kind: "agent", ttl_ms: 60_000 });
    assert.equal(agent.status, 201);
    const replay = await request(endpoint, "/api/leases/acquire", { owner: "player-test", kind: "replay", ttl_ms: 60_000 });
    assert.equal(replay.status, 201);
    // While the browser process lives, the daemon stays up.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.equal(daemon.exitCode, null);
    fakeBrowser.kill("SIGKILL");
    // The closure is noticed and the stale state cleared, but an active replay
    // viewer defers the shutdown.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.equal(daemon.exitCode, null, "an active replay viewer keeps the daemon serving");
    assert.equal(existsSync(join(home, "browser.json")), false, "the stale browser state is cleared as soon as the closure is noticed");
    await request(endpoint, "/api/leases/release", { lease_id: replay.body.lease_id });
    // The agent lease is still live — closure of the controlled browser overrides it.
    await waitForExit(daemon);
  } finally {
    await stop(daemon);
    if (fakeBrowser.exitCode === null) fakeBrowser.kill("SIGKILL");
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
  return { status: response.status, body: await response.json() as { error?: string; lease_id?: string } };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
}

async function waitForExit(child: ChildProcess) {
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Fixture daemon did not exit after its idle timeout.")), 3_000)),
  ]);
}
