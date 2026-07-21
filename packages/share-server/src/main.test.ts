import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSession, SessionStore } from "../../core/dist/index.js";

test("uploads a portable artifact and serves its replay data", async () => {
  const source = await mkdtemp(join(tmpdir(), "replay-share-source-"));
  const data = await mkdtemp(join(tmpdir(), "replay-share-data-"));
  const previousHome = process.env.REPLAY_HOME;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  try {
    process.env.REPLAY_HOME = source;
    const store = await SessionStore.create({
      format_version: 1, id: "replay_share_fixture", title: "Shared fixture", created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false }, origins: ["http://fixture.test"], masking: { mask_all_inputs: false, passwords: true }, segments: [], tab_events: [], markers: [], assets: [],
    });
    store.segment("seg_1", "http://fixture.test", 0);
    await store.append("seg_1", [{ type: 2, timestamp: 1 }, { type: 3, timestamp: 2 }], Date.now());
    store.addMarker({ t_ms: 1, label: "Bug reproduced", note: "The save button did nothing" });
    store.addAction({ id: "act_1", tool: "browser_click", args_summary: "#save", started_at_ms: 0, finished_at_ms: 1, ok: false });
    await store.finalize();
    const artifact = join(source, "fixture.replay");
    await exportSession("replay_share_fixture", artifact);
    server = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), REPLAY_SHARE_DATA_DIR: data, REPLAY_SHARE_PUBLIC_URL: endpoint, REPLAY_RELEASE_PUBLISH_TOKEN: "test-release-token" }, stdio: "ignore" });
    await waitForHealth(endpoint);
    const upload = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: await readFile(artifact) });
    assert.equal(upload.status, 201);
    const handoff = await upload.json() as { shareId: string; shareUrl: string; sessionId: string; summaryUrl: string };
    assert.equal(handoff.sessionId, "replay_share_fixture");
    assert.equal(handoff.summaryUrl, `${handoff.shareUrl}.md`);
    // Re-sharing the same replay is idempotent: it must not fail on the
    // duplicate import and should hand back the replay's existing link.
    const reupload = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: await readFile(artifact) });
    assert.equal(reupload.status, 201);
    const rehandoff = await reupload.json() as { shareUrl: string; sessionId: string };
    assert.equal(rehandoff.sessionId, "replay_share_fixture");
    assert.equal(rehandoff.shareUrl, handoff.shareUrl);
    const redirect = await fetch(handoff.shareUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/replay?id=replay_share_fixture");
    // The same share link is agent-readable: explicit .md, or content
    // negotiation when the client prefers markdown over the player redirect.
    const markdown = await fetch(handoff.summaryUrl);
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get("content-type") ?? "", /text\/markdown/);
    const markdownBody = await markdown.text();
    assert.match(markdownBody, /Shared fixture/);
    assert.match(markdownBody, /Opened http:\/\/fixture\.test/);
    assert.match(markdownBody, /Marker: Bug reproduced — The save button did nothing/);
    assert.match(markdownBody, /Agent browser actions \(1, 1 FAILED\):/);
    assert.match(markdownBody, /browser_click #save — FAILED/);
    assert.ok(markdownBody.includes(`${handoff.shareUrl}.json`));
    // The public summary identifies the replay by share id, never the spool session id.
    assert.ok(!markdownBody.includes("replay_share_fixture"));
    const negotiated = await fetch(handoff.shareUrl, { headers: { accept: "text/markdown" }, redirect: "manual" });
    assert.equal(negotiated.status, 200);
    assert.match(negotiated.headers.get("content-type") ?? "", /text\/markdown/);
    const summaryResponse = await fetch(`${handoff.shareUrl}.json`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as { id: string; title: string; steps: { kind: string }[] };
    assert.equal(summary.title, "Shared fixture");
    assert.equal(`${endpoint}/r/${summary.id}`, handoff.shareUrl);
    assert.ok(summary.steps.some((step) => step.kind === "page"));
    const missingSummary = await fetch(`${endpoint}/r/${"0".repeat(24)}.md`);
    assert.equal(missingSummary.status, 404);
    // The scoped query API is keyed by share id only.
    const apiSummary = await fetch(`${endpoint}/v1/replays/${handoff.shareId}/summary`);
    assert.equal(apiSummary.status, 200);
    assert.equal((await apiSummary.json() as { id: string }).id, handoff.shareId);
    const stepsByMarker = await fetch(`${endpoint}/v1/replays/${handoff.shareId}/steps?marker=Bug reproduced`);
    assert.equal(stepsByMarker.status, 200);
    const window = await stepsByMarker.json() as { from_ms: number; to_ms: number; steps: { kind: string }[] };
    assert.ok(window.steps.some((step) => step.kind === "marker"));
    assert.equal((await fetch(`${endpoint}/v1/replays/${handoff.shareId}/steps?from_ms=abc`)).status, 400);
    assert.equal((await fetch(`${endpoint}/v1/replays/${handoff.shareId}/steps?marker=no such marker`)).status, 404);
    const actions = await fetch(`${endpoint}/v1/replays/${handoff.shareId}/actions`);
    assert.deepEqual(await actions.json(), [{ id: "act_1", tool: "browser_click", args_summary: "#save", started_at_ms: 0, finished_at_ms: 1, ok: false }]);
    const markers = await fetch(`${endpoint}/v1/replays/${handoff.shareId}/markers`);
    assert.equal((await markers.json() as { label: string }[])[0]?.label, "Bug reproduced");
    const bundle = await fetch(`${endpoint}/v1/replays/${handoff.shareId}/bundle`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get("content-type"), "application/vnd.replay");
    const bundleBytes = Buffer.from(await bundle.arrayBuffer());
    assert.ok(bundleBytes.byteLength > 2 && bundleBytes[0] === 0x1f && bundleBytes[1] === 0x8b, "bundle should be a gzipped .replay artifact");
    // The player addresses the same download by (public) session id so a viewer
    // can re-export the replay straight from the Download control.
    const sessionBundle = await fetch(`${endpoint}/api/sessions/replay_share_fixture/bundle`);
    assert.equal(sessionBundle.status, 200);
    assert.equal(sessionBundle.headers.get("content-type"), "application/vnd.replay");
    assert.match(sessionBundle.headers.get("content-disposition") ?? "", /attachment; filename="replay-replay_share_fixture\.replay"/);
    assert.deepEqual(Buffer.from(await sessionBundle.arrayBuffer()), bundleBytes);
    assert.equal((await fetch(`${endpoint}/api/sessions/never-shared/bundle`)).status, 404);
    // Revoking a share kills the link everywhere — player redirect, summaries,
    // query API, and the session data routes the player depends on — and a
    // later re-upload mints a fresh share instead of resurrecting the dead one.
    const sharesFile = join(data, "shares.json");
    const shareRows = JSON.parse(await readFile(sharesFile, "utf8")) as { id: string; revoked?: boolean }[];
    shareRows.find((entry) => entry.id === handoff.shareId)!.revoked = true;
    await writeFile(sharesFile, JSON.stringify(shareRows));
    assert.equal((await fetch(handoff.shareUrl, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(handoff.summaryUrl)).status, 404);
    assert.equal((await fetch(`${endpoint}/v1/replays/${handoff.shareId}/summary`)).status, 404);
    assert.equal((await fetch(`${endpoint}/api/sessions/replay_share_fixture/manifest`)).status, 404);
    assert.equal((await fetch(`${endpoint}/api/sessions/replay_share_fixture/bundle`)).status, 404);
    const reissued = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: await readFile(artifact) });
    assert.equal(reissued.status, 201);
    const fresh = await reissued.json() as { shareId: string };
    assert.notEqual(fresh.shareId, handoff.shareId);
    assert.equal((await fetch(`${endpoint}/v1/replays/${fresh.shareId}/summary`)).status, 200);
    const manifest = await fetch(`${endpoint}/api/sessions/replay_share_fixture/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json() as { title: string }).title, "Shared fixture");
    const denied = await fetch(`${endpoint}/v1/releases`, { method: "PUT", body: Buffer.from("release") });
    assert.equal(denied.status, 403);
    const published = await fetch(`${endpoint}/v1/releases`, {
      method: "PUT",
      headers: { authorization: "Bearer test-release-token", "x-replay-release-version": "0.2.0", "x-replay-release-platform": "darwin-arm64" },
      body: Buffer.from("release"),
    });
    assert.equal(published.status, 201);
    const latest = await fetch(`${endpoint}/v1/releases/latest?platform=darwin-arm64`);
    assert.equal(latest.status, 200);
    const metadata = await latest.json() as { version: string; archiveUrl: string; sha256: string };
    assert.equal(metadata.version, "0.2.0");
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Buffer.from(await (await fetch(metadata.archiveUrl)).arrayBuffer()), Buffer.from("release"));
    const pinned = await fetch(`${endpoint}/v1/releases/0.2.0?platform=darwin-arm64`);
    assert.equal(pinned.status, 200);
    assert.equal((await pinned.json() as { version: string }).version, "0.2.0");
    const absent = await fetch(`${endpoint}/v1/releases/9.9.9?platform=darwin-arm64`);
    assert.equal(absent.status, 404);
    const duplicate = await fetch(`${endpoint}/v1/releases`, {
      method: "PUT",
      headers: { authorization: "Bearer test-release-token", "x-replay-release-version": "0.2.0", "x-replay-release-platform": "darwin-arm64" },
      body: Buffer.from("replacement"),
    });
    assert.equal(duplicate.status, 409);
  } finally {
    if (server) await stop(server);
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(source, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("maps client faults to their own status instead of a blanket 500", async () => {
  const data = await mkdtemp(join(tmpdir(), "replay-share-faults-"));
  const previousHome = process.env.REPLAY_HOME;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), REPLAY_SHARE_DATA_DIR: data, REPLAY_SHARE_PUBLIC_URL: endpoint, REPLAY_SHARE_MAX_UPLOAD_BYTES: "1024", REPLAY_RELEASE_PUBLISH_TOKEN: "test-release-token" }, stdio: "ignore" });
    await waitForHealth(endpoint);

    // Oversize upload → 413, not 500.
    const oversize = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: Buffer.alloc(2048) });
    assert.equal(oversize.status, 413);

    // A body under the limit that is not a valid artifact → 422.
    const garbage = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: Buffer.from("not a real .replay bundle") });
    assert.equal(garbage.status, 422);

    // A replay that was never uploaded → 404.
    const missing = await fetch(`${endpoint}/api/sessions/replay_absent/manifest`);
    assert.equal(missing.status, 404);

    // A malformed release header → 400, not 500.
    const badVersion = await fetch(`${endpoint}/v1/releases`, {
      method: "PUT",
      headers: { authorization: "Bearer test-release-token", "x-replay-release-version": "not-a-version", "x-replay-release-platform": "darwin-arm64" },
      body: Buffer.from("release"),
    });
    assert.equal(badVersion.status, 400);

    // Stats are not exposed unless a token is configured, so the endpoint is not
    // even discoverable on a default deployment.
    const statsDisabled = await fetch(`${endpoint}/stats`);
    assert.equal(statsDisabled.status, 404);
  } finally {
    if (server) await stop(server);
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(data, { recursive: true, force: true });
  }
});

test("rate limits the upload path per client and reports a retry window", async () => {
  const data = await mkdtemp(join(tmpdir(), "replay-share-rate-"));
  const previousHome = process.env.REPLAY_HOME;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  try {
    // One upload per window: the first request is admitted (and rejected on its
    // own merits), the second is turned away by the limiter before routing.
    server = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), REPLAY_SHARE_DATA_DIR: data, REPLAY_SHARE_PUBLIC_URL: endpoint, REPLAY_SHARE_UPLOAD_RATE_LIMIT_POINTS: "1", REPLAY_SHARE_UPLOAD_RATE_LIMIT_DURATION: "60" }, stdio: "ignore" });
    await waitForHealth(endpoint);

    const first = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: Buffer.from("not a real .replay bundle") });
    assert.equal(first.status, 422);
    const second = await fetch(`${endpoint}/v1/replays`, { method: "POST", body: Buffer.from("not a real .replay bundle") });
    assert.equal(second.status, 429);
    const retryAfter = Number(second.headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after should be a positive window, got ${retryAfter}`);

    // Reads use a separate, generous budget, so a health probe is unaffected.
    assert.equal((await fetch(`${endpoint}/health`)).status, 200);
  } finally {
    if (server) await stop(server);
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(data, { recursive: true, force: true });
  }
});

test("exposes token-guarded stats counters", async () => {
  const data = await mkdtemp(join(tmpdir(), "replay-share-stats-"));
  const previousHome = process.env.REPLAY_HOME;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), REPLAY_SHARE_DATA_DIR: data, REPLAY_SHARE_PUBLIC_URL: endpoint, REPLAY_SHARE_STATS_TOKEN: "test-stats-token" }, stdio: "ignore" });
    await waitForHealth(endpoint);

    // A rejected upload should register in the counters we read back.
    assert.equal((await fetch(`${endpoint}/v1/replays`, { method: "POST", body: Buffer.from("garbage") })).status, 422);

    assert.equal((await fetch(`${endpoint}/stats`)).status, 401);
    assert.equal((await fetch(`${endpoint}/stats`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const stats = await fetch(`${endpoint}/stats`, { headers: { authorization: "Bearer test-stats-token" } });
    assert.equal(stats.status, 200);
    const snapshot = await stats.json() as { service: string; uptime_seconds: number; requests: { total: number }; uploads: { rejected_invalid: number } };
    assert.equal(snapshot.service, "replay-share-server");
    assert.ok(Number.isInteger(snapshot.uptime_seconds) && snapshot.uptime_seconds >= 0);
    assert.ok(snapshot.requests.total >= 1);
    assert.equal(snapshot.uploads.rejected_invalid, 1);
  } finally {
    if (server) await stop(server);
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(data, { recursive: true, force: true });
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
    try { if ((await fetch(`${endpoint}/health`)).ok) return; } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Share fixture did not start: ${String(lastError)}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
}
