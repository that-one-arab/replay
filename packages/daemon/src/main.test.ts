import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("daemon reports an unattached browser and rejects unsafe or premature capture requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-"));
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port) },
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

    // Driving the browser is never gated on the capture: an action reported
    // while nothing captures is acknowledged and dropped, not failed.
    const idleAction = await request(endpoint, "/api/sessions/action", { id: "act_1", tool: "browser_click", started_at_epoch_ms: Date.now() - 5, finished_at_epoch_ms: Date.now(), ok: true, marker: { label: "ignored" } });
    assert.equal(idleAction.status, 200);
    assert.equal(idleAction.body.captured, false);

    const invalidAction = await request(endpoint, "/api/sessions/action", { tool: "browser_click" });
    assert.equal(invalidAction.status, 500);
    assert.match(String(invalidAction.body.error), /requires id, tool/);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("replay leases keep the daemon alive while agent leases control browser ownership", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-leases-"));
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port), REPLAY_BROWSER_IDLE_TIMEOUT_MS: "1000", REPLAY_DAEMON_IDLE_TIMEOUT_MS: "1000" },
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
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-browser-close-"));
  // A quiet long-lived process stands in for the managed Chrome; a pre-existing
  // browser.json makes the daemon adopt its pid at startup.
  const fakeBrowser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  await writeFile(join(home, "browser.json"), JSON.stringify({ pid: fakeBrowser.pid, cdp_endpoint: "http://127.0.0.1:1" }) + "\n");
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    // Idle timeouts far beyond the test window prove any exit comes from the
    // browser-close path, not the idle timers.
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port), REPLAY_BROWSER_IDLE_TIMEOUT_MS: "600000", REPLAY_DAEMON_IDLE_TIMEOUT_MS: "600000" },
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

test("the daemon exits with a clear error when its port is already taken", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-port-"));
  const squatter = createServer((_, response) => { response.writeHead(200); response.end("not replay"); });
  squatter.listen(0, "127.0.0.1");
  await once(squatter, "listening");
  const address = squatter.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a fixture port.");
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(address.port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr?.setEncoding("utf8");
  daemon.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const [code] = await once(daemon, "exit") as [number | null];
    assert.equal(code, 1);
    assert.match(stderr, /already in use/);
    assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${address.port}`));
  } finally {
    await stop(daemon);
    await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
    await rm(home, { recursive: true, force: true });
  }
});

test("capture_highlight validates defect claims before reaching the capture", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-highlight-"));
  const port = await unusedPort();
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port) },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(endpoint);
    // A defect must carry both halves; validation runs before the capture is touched.
    const halfDefect = await request(endpoint, "/api/sessions/highlight", { element: { text: "1 of 3" }, defect: { expected: "Step 2 of 3" } });
    assert.equal(halfDefect.status, 500);
    assert.match(String(halfDefect.body.error), /both expected and actual/);
    // A defect and a note are mutually exclusive.
    const both = await request(endpoint, "/api/sessions/highlight", { defect: { expected: "a", actual: "b" }, note: "c" });
    assert.equal(both.status, 500);
    assert.match(String(both.body.error), /either a defect or a note/);
    // An invalid hold value is rejected.
    const badHold = await request(endpoint, "/api/sessions/highlight", { note: "x", hold: "forever" });
    assert.equal(badHold.status, 500);
    assert.match(String(badHold.body.error), /beat, until_ack, or none/);
    // A well-formed highlight passes validation; with no capture active it fails
    // at the capture guard instead, proving the schema was accepted.
    const valid = await request(endpoint, "/api/sessions/highlight", { element: { text: "1 of 3 completed" }, defect: { expected: "Step 2 of 3", actual: "1 of 3 completed" }, hold: "until_ack" });
    assert.equal(valid.status, 500);
    assert.match(String(valid.body.error), /No capture is active/);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("the review endpoint assesses a stopped session on disk, and latest resolves the newest", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-daemon-review-"));
  const port = await unusedPort();
  const sessionId = "replay_review_test";
  await mkdir(join(home, "sessions", sessionId), { recursive: true });
  await writeFile(join(home, "sessions", sessionId, "manifest.json"), JSON.stringify({
    format_version: 1,
    id: sessionId,
    title: "Review fixture",
    created_at: "2026-01-01T00:00:00.000Z",
    stopped_at: "2026-01-01T00:04:14.000Z",
    outcome: "reproduced",
    capture: { version: "0.1.0", rrweb: "2.0.0-alpha.20", capture_canvas: false, capture_cross_origin_iframes: false },
    origins: ["https://app.example.com"],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [{ id: "seg_1", page_url: "https://app.example.com/login", clock_offset_ms: 0, chunks: [] }],
    tab_events: [],
    markers: [{ t_ms: 1_000, label: "Submitted" }],
    actions: [{ id: "act_1", tool: "browser_find", started_at_ms: 2_000, finished_at_ms: 2_010, ok: true }],
    assets: [],
  }));
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port) },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(endpoint);
    const review = await fetch(`${endpoint}/api/sessions/${sessionId}/review`);
    assert.equal(review.status, 200);
    const reviewBody = await review.json() as { summary_text: string; findings: { code: string; severity: string }[] };
    assert.match(reviewBody.summary_text, /Review fixture/, "the distilled timeline is rendered from the on-disk session");
    assert.deepEqual(reviewBody.findings.map((finding) => finding.code), ["opens_on_auth_page", "no_resolved_defect_highlight", "discovery_noise_after_last_marker"]);
    assert.equal(reviewBody.findings.find((finding) => finding.code === "no_resolved_defect_highlight")!.severity, "error", "a reproduced outcome escalates the defect finding");
    const latest = await fetch(`${endpoint}/api/sessions/latest`);
    assert.equal(latest.status, 200);
    assert.equal((await latest.json() as { sessionId: string }).sessionId, sessionId);
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
  return { status: response.status, body: await response.json() as { error?: string; lease_id?: string; captured?: boolean } };
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
