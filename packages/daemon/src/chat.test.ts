import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

/**
 * Chat backend tests run the real daemon with a fake `codex` on PATH that
 * speaks the exec --json protocol, so turn flow, SSE transcripts, resume,
 * and failure mapping are covered without a signed-in provider.
 */

const BASE = 1_700_000_000_000;

async function seedRecording(home: string, id: string) {
  const root = join(home, "sessions", id);
  await mkdir(join(root, "events"), { recursive: true });
  const events = [
    { type: 2, timestamp: BASE, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 10, tagName: "body", attributes: {}, childNodes: [{ type: 2, id: 11, tagName: "button", attributes: {}, childNodes: [{ type: 3, id: 12, textContent: "Checkout" }] }] }] } } },
    { type: 3, timestamp: BASE + 1_000, data: { source: 2, type: 2, id: 11, x: 3, y: 3 } },
  ];
  const chunk = events.map((event) => JSON.stringify({ segment_id: "seg-1", received_at_ms: BASE, event })).join("\n") + "\n";
  await writeFile(join(root, "events/seg-1-0000.jsonl.gz"), gzipSync(chunk));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    format_version: 1,
    id,
    title: "Chat fixture",
    created_at: new Date(BASE).toISOString(),
    recorder: { version: "0", rrweb: "0", record_canvas: false, record_cross_origin_iframes: false },
    origins: [],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [{ id: "seg-1", page_url: "http://127.0.0.1:4173/", clock_offset_ms: 0, chunks: ["events/seg-1-0000.jsonl.gz"] }],
    tab_events: [],
    markers: [{ t_ms: 1_000, label: "Pressed checkout" }],
    assets: [],
  }));
}

async function fakeCodex(dir: string, behavior: "echo" | "unauthenticated") {
  const script = behavior === "echo"
    ? `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumed = args.includes("resume");
const prompt = args[args.length - 1];
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fixture" }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: (resumed ? "resumed:" : "first:") + prompt.slice(-40) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`
    : `#!/usr/bin/env node
console.error("Error: not logged in. Run codex login.");
process.exit(1);
`;
  const path = join(dir, "codex");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

async function startDaemon(home: string, port: number, pathPrefix: string) {
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    env: { ...process.env, REC_HOME: home, REC_PORT: String(port), PATH: `${pathPrefix}:${process.env.PATH ?? ""}` },
    stdio: "ignore",
  });
  await waitForHealth(`http://127.0.0.1:${port}`);
  return daemon;
}

test("chat turns stream over SSE, resume the provider thread, and expose tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-chat-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await fakeCodex(bin, "echo");
  await seedRecording(home, "rec_fixture");
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, bin);
  try {
    const availability = await request(endpoint, "GET", "/api/chat/availability");
    assert.equal(availability.body.available, true);
    assert.equal(availability.body.provider, "codex");

    const health = await request(endpoint, "GET", "/health");
    assert.equal(health.body.chat_available, true);

    const tools = await request(endpoint, "GET", "/api/chat/tools");
    assert.ok(Array.isArray(tools.body) && tools.body.some((tool: { name?: string }) => tool.name === "seek"));

    const chatId = "chat-test-0001";
    const stream = await startStream(endpoint, chatId, "rec_fixture");
    const first = await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "What happened here?" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await stream.waitFor((events) => events.some((event) => event.event === "turn" && event.data.status === "completed"));
    const firstMessage = stream.events.find((event) => event.event === "message");
    assert.ok(String(firstMessage?.data.text).startsWith("first:"), "first turn includes the context-bearing prompt");

    const second = await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "And then?" });
    assert.equal(second.status, 202);
    await stream.waitFor((events) => events.filter((event) => event.event === "turn" && event.data.status === "completed").length >= 2);
    const resumeMessage = stream.events.filter((event) => event.event === "message").at(-1);
    assert.ok(String(resumeMessage?.data.text).startsWith("resumed:"), "later turns resume the provider thread");

    // Server-side tools respond directly through the bridge endpoint.
    const overview = await request(endpoint, "POST", "/api/chat/tool", { chat_id: chatId, name: "get_replay_overview", arguments: {} });
    assert.equal(overview.status, 200);
    assert.match(String(overview.body.result), /Chat fixture/);
    assert.match(String(overview.body.result), /Clicked button "Checkout"/);

    const range = await request(endpoint, "POST", "/api/chat/tool", { chat_id: chatId, name: "get_steps", arguments: { from_ms: 0, to_ms: 5_000 } });
    assert.match(String(range.body.result), /Pressed checkout/);

    // A UI tool with no rules other than a connected player relays and times out fast when unanswered — here we answer it.
    const seekPromise = request(endpoint, "POST", "/api/chat/tool", { chat_id: chatId, name: "seek", arguments: { t_ms: 1000 } });
    await stream.waitFor((events) => events.some((event) => event.event === "tool_request"));
    const call = stream.events.find((event) => event.event === "tool_request")!;
    assert.equal(call.data.name, "seek");
    await request(endpoint, "POST", "/api/chat/tool-result", { chat_id: chatId, call_id: call.data.call_id, ok: true, result: "Playhead moved" });
    const seek = await seekPromise;
    assert.equal(seek.body.result, "Playhead moved");

    // Reconnecting replays the transcript.
    const replayStream = await startStream(endpoint, chatId, "rec_fixture");
    await replayStream.waitFor((events) => events.some((event) => event.event === "history"));
    const history = replayStream.events.find((event) => event.event === "history")!;
    assert.ok((history.data.events as { type: string }[]).some((item) => item.type === "user_message"));
    replayStream.close();
    stream.close();
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("chat surfaces provider failures and honors disabled config", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-chat-fail-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await fakeCodex(bin, "unauthenticated");
  await seedRecording(home, "rec_fixture");
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, bin);
  try {
    const chatId = "chat-test-0002";
    const stream = await startStream(endpoint, chatId, "rec_fixture");
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "hello" });
    await stream.waitFor((events) => events.some((event) => event.event === "turn" && event.data.status === "failed"));
    const failed = stream.events.find((event) => event.event === "turn" && event.data.status === "failed")!;
    assert.equal(failed.data.error_code, "unauthenticated");
    assert.match(String(failed.data.error), /codex login/);
    stream.close();

    const missing = await request(endpoint, "GET", "/api/chat/stream?chat=chat-test-0003&session=rec_missing");
    assert.equal(missing.status, 500);

    const badChat = await request(endpoint, "POST", "/api/chat/message", { chat_id: "never-connected", text: "hi" });
    assert.equal(badChat.status, 500);
    assert.match(String(badChat.body.error), /not found/i);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("chat availability reflects a disabled config and a missing provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "rec-chat-config-"));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), `[chat]\nenabled = false\n`);
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, join(home, "bin-empty"));
  try {
    const disabled = await request(endpoint, "GET", "/api/chat/availability");
    assert.equal(disabled.body.available, false);
    assert.equal(disabled.body.reason, "disabled");
    const health = await request(endpoint, "GET", "/health");
    assert.equal(health.body.chat_available, false);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

type StreamEvent = { event: string; data: Record<string, unknown> };

async function startStream(endpoint: string, chatId: string, sessionId: string) {
  const response = await fetch(`${endpoint}/api/chat/stream?chat=${chatId}&session=${sessionId}`, { headers: { accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  const events: StreamEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let notify: (() => void) | undefined;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (eventLine && dataLine) events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> });
      }
      notify?.();
    }
  })();
  void pump;
  return {
    events,
    waitFor: async (predicate: (events: StreamEvent[]) => boolean, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for stream state. Saw: ${JSON.stringify(events)}`);
        await new Promise<void>((resolveWait) => { notify = resolveWait; setTimeout(resolveWait, 100); });
      }
      return events;
    },
    close: () => void reader.cancel().catch(() => undefined),
  };
}

async function request(endpoint: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

async function waitForHealth(endpoint: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch { /* daemon still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Daemon did not become healthy.");
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a fixture port.");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function stop(daemon: ChildProcess) {
  if (daemon.exitCode !== null) return;
  daemon.kill("SIGTERM");
  await Promise.race([once(daemon, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  if (daemon.exitCode === null) daemon.kill("SIGKILL");
}
