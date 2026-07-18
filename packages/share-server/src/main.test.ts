import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSession, SessionStore } from "../../core/dist/index.js";

test("uploads a portable artifact and serves its replay data", async () => {
  const source = await mkdtemp(join(tmpdir(), "rec-share-source-"));
  const data = await mkdtemp(join(tmpdir(), "rec-share-data-"));
  const previousHome = process.env.REC_HOME;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  try {
    process.env.REC_HOME = source;
    const store = await SessionStore.create({
      format_version: 1, id: "rec_share_fixture", title: "Shared fixture", created_at: new Date().toISOString(),
      recorder: { version: "test", rrweb: "test", record_canvas: false, record_cross_origin_iframes: false }, origins: ["http://fixture.test"], masking: { mask_all_inputs: false, passwords: true }, segments: [], tab_events: [], markers: [], assets: [],
    });
    store.segment("seg_1", "http://fixture.test", 0);
    await store.append("seg_1", [{ type: 2, timestamp: 1 }, { type: 3, timestamp: 2 }], Date.now());
    await store.finalize();
    const artifact = join(source, "fixture.rec");
    await exportSession("rec_share_fixture", artifact);
    server = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), REC_SHARE_DATA_DIR: data, REC_SHARE_PUBLIC_URL: endpoint }, stdio: "ignore" });
    await waitForHealth(endpoint);
    const upload = await fetch(`${endpoint}/v1/recordings`, { method: "POST", body: await readFile(artifact) });
    assert.equal(upload.status, 201);
    const handoff = await upload.json() as { shareUrl: string; sessionId: string };
    assert.equal(handoff.sessionId, "rec_share_fixture");
    const redirect = await fetch(handoff.shareUrl, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/replay?id=rec_share_fixture");
    const manifest = await fetch(`${endpoint}/api/sessions/rec_share_fixture/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json() as { title: string }).title, "Shared fixture");
  } finally {
    if (server) await stop(server);
    if (previousHome === undefined) delete process.env.REC_HOME;
    else process.env.REC_HOME = previousHome;
    await rm(source, { recursive: true, force: true });
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
