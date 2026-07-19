import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { uploadRecording } from "./share-client.js";

const noWait = async () => undefined;

async function withArtifact(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "rec-share-client-"));
  const path = join(dir, "fixture.rec");
  await writeFile(path, Buffer.from("portable-bundle"));
  try { await run(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("returns the share URL on a successful upload", async () => {
  await withArtifact(async (path) => {
    const calls: string[] = [];
    const result = await uploadRecording("https://share.example/", path, {
      sleep: noWait,
      fetchImpl: async (url) => { calls.push(String(url)); return jsonResponse(201, { shareUrl: "https://share.example/r/abc", sessionId: "rec_1" }); },
    });
    assert.deepEqual(calls, ["https://share.example/v1/recordings"]);
    assert.equal(result.shareUrl, "https://share.example/r/abc");
    assert.equal(result.sessionId, "rec_1");
  });
});

test("retries a transient 5xx, then succeeds", async () => {
  await withArtifact(async (path) => {
    let attempt = 0;
    const result = await uploadRecording("https://share.example", path, {
      sleep: noWait,
      fetchImpl: async () => { attempt += 1; return attempt < 3 ? jsonResponse(503, { error: "warming up" }) : jsonResponse(201, { shareUrl: "https://share.example/r/xyz" }); },
    });
    assert.equal(attempt, 3);
    assert.equal(result.shareUrl, "https://share.example/r/xyz");
  });
});

test("does not retry a 4xx and surfaces the server's reason", async () => {
  await withArtifact(async (path) => {
    let attempt = 0;
    await assert.rejects(
      uploadRecording("https://share.example", path, {
        sleep: noWait,
        fetchImpl: async () => { attempt += 1; return jsonResponse(413, { error: "Recording exceeds the upload limit." }); },
      }),
      /rejected the recording \(413: Recording exceeds the upload limit\.\)/,
    );
    assert.equal(attempt, 1);
  });
});

test("wraps a connection failure into a clear, endpoint-named error", async () => {
  await withArtifact(async (path) => {
    let attempt = 0;
    await assert.rejects(
      uploadRecording("https://share.example", path, {
        attempts: 2,
        sleep: noWait,
        fetchImpl: async () => { attempt += 1; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); },
      }),
      /Could not reach the share server at https:\/\/share\.example: the connection was refused\./,
    );
    assert.equal(attempt, 2);
  });
});

test("reports a timeout distinctly from a refused connection", async () => {
  await withArtifact(async (path) => {
    await assert.rejects(
      uploadRecording("https://share.example", path, {
        attempts: 1,
        timeoutMs: 5_000,
        sleep: noWait,
        fetchImpl: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
      }),
      /did not respond within 5s\./,
    );
  });
});

test("fails clearly when a 2xx omits the share URL", async () => {
  await withArtifact(async (path) => {
    await assert.rejects(
      uploadRecording("https://share.example", path, { sleep: noWait, fetchImpl: async () => jsonResponse(201, {}) }),
      /accepted the recording but returned no share link\./,
    );
  });
});
