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

async function seedReplay(home: string, id: string) {
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
    capture: { version: "0", rrweb: "0", capture_canvas: false, capture_cross_origin_iframes: false },
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

async function startDaemon(home: string, port: number, pathPrefix: string, extraEnv: Record<string, string> = {}) {
  // The host machine may carry an OPENAI_API_KEY; strip it so "auto" provider
  // selection inside these fixtures stays deterministic.
  const env: NodeJS.ProcessEnv = { ...process.env, REPLAY_HOME: home, REPLAY_PORT: String(port), PATH: `${pathPrefix}:${process.env.PATH ?? ""}` };
  delete env.OPENAI_API_KEY;
  delete env.REPLAY_CHAT_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.REPLAY_CHAT_PROVIDER;
  Object.assign(env, extraEnv);
  const daemon = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], { env, stdio: "ignore" });
  await waitForHealth(`http://127.0.0.1:${port}`);
  return daemon;
}

test("chat turns stream over SSE, resume the provider thread, and expose tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await fakeCodex(bin, "echo");
  await seedReplay(home, "replay_fixture");
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
    const stream = await startStream(endpoint, chatId, "replay_fixture");
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
    const replayStream = await startStream(endpoint, chatId, "replay_fixture");
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

test("editing a message drops later turns and rebuilds the conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-edit-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await fakeCodex(bin, "echo");
  await seedReplay(home, "replay_fixture");
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, bin);
  try {
    const chatId = "chat-edit-0001";
    const stream = await startStream(endpoint, chatId, "replay_fixture");
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "alpha question" });
    await stream.waitFor((events) => events.filter((event) => event.event === "turn" && event.data.status === "completed").length >= 1);
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "bravo question" });
    await stream.waitFor((events) => events.filter((event) => event.event === "turn" && event.data.status === "completed").length >= 2);
    assert.ok(String(stream.events.filter((event) => event.event === "message").at(-1)?.data.text).startsWith("resumed:"), "the second turn resumed the thread");

    // Locate the second user message in the ordered transcript.
    const peek = await startStream(endpoint, chatId, "replay_fixture");
    await peek.waitFor((events) => events.some((event) => event.event === "history"));
    const before = peek.events.find((event) => event.event === "history")!.data.events as { type: string; text?: string }[];
    peek.close();
    const secondUserIndex = before.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "user_message")[1]!.index;

    const edit = await request(endpoint, "POST", "/api/chat/edit", { chat_id: chatId, index: secondUserIndex, text: "charlie question" });
    assert.equal(edit.status, 202, JSON.stringify(edit.body));
    await stream.waitFor((events) => events.filter((event) => event.event === "turn" && event.data.status === "completed").length >= 3);

    // The rebuilt turn runs on a fresh thread (not a resume) and carries the edited text.
    const rebuilt = stream.events.filter((event) => event.event === "message").at(-1);
    assert.ok(String(rebuilt?.data.text).startsWith("first:"), "editing rebuilds the conversation from a clean thread");
    assert.match(String(rebuilt?.data.text), /charlie question/);

    // Reconnecting shows the transcript truncated: the replaced turn is gone.
    const after = await startStream(endpoint, chatId, "replay_fixture");
    await after.waitFor((events) => events.some((event) => event.event === "history"));
    const events = after.events.find((event) => event.event === "history")!.data.events as { type: string; text?: string }[];
    after.close();
    assert.deepEqual(events.filter((entry) => entry.type === "user_message").map((entry) => entry.text), ["alpha question", "charlie question"]);
    assert.ok(!events.some((entry) => entry.text === "bravo question"), "the replaced message and its answer are removed");

    // A non-user entry cannot be edited.
    const bad = await request(endpoint, "POST", "/api/chat/edit", { chat_id: chatId, index: 1, text: "nope" });
    assert.equal(bad.status, 500);
    assert.match(String(bad.body.error), /your own messages/i);
    stream.close();
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("chat surfaces provider failures and honors disabled config", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-fail-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await fakeCodex(bin, "unauthenticated");
  await seedReplay(home, "replay_fixture");
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, bin);
  try {
    const chatId = "chat-test-0002";
    const stream = await startStream(endpoint, chatId, "replay_fixture");
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "hello" });
    await stream.waitFor((events) => events.some((event) => event.event === "turn" && event.data.status === "failed"));
    const failed = stream.events.find((event) => event.event === "turn" && event.data.status === "failed")!;
    assert.equal(failed.data.error_code, "unauthenticated");
    assert.match(String(failed.data.error), /codex login/);
    stream.close();

    const missing = await request(endpoint, "GET", "/api/chat/stream?chat=chat-test-0003&session=replay_missing");
    assert.equal(missing.status, 500);

    const badChat = await request(endpoint, "POST", "/api/chat/message", { chat_id: "never-connected", text: "hi" });
    assert.equal(badChat.status, 500);
    assert.match(String(badChat.body.error), /not found/i);
  } finally {
    await stop(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

test("openai provider streams deltas, resolves tool calls, and reuses one conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-openai-"));
  await seedReplay(home, "replay_fixture");
  const fake = await startFakeOpenAi();
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, join(home, "bin-none"), {
    REPLAY_CHAT_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: fake.url,
  });
  try {
    const availability = await request(endpoint, "GET", "/api/chat/availability");
    assert.equal(availability.body.available, true);
    assert.equal(availability.body.provider, "openai");

    const chatId = "chat-openai-0001";
    const stream = await startStream(endpoint, chatId, "replay_fixture");
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "What happened?" });
    await stream.waitFor((events) => events.some((event) => event.event === "turn" && event.data.status === "completed"));
    const deltas = stream.events.filter((event) => event.event === "message_delta").map((event) => event.data.text).join("");
    assert.equal(deltas, "Hello from the fixture.");
    const message = stream.events.find((event) => event.event === "message");
    assert.equal(message?.data.text, "Hello from the fixture.");

    // Second turn: the fixture responds with a function_call for a server-side
    // tool, then answers with text that echoes the tool output.
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "use the tool" });
    await stream.waitFor((events) => events.filter((event) => event.event === "turn" && event.data.status === "completed").length >= 2);
    const activity = stream.events.find((event) => event.event === "activity");
    assert.equal(activity?.data.label, "Reviewed the timeline");
    assert.equal(activity?.data.status, "completed");
    const final = stream.events.filter((event) => event.event === "message").at(-1);
    assert.match(String(final?.data.text), /tool result received/);
    assert.match(fake.state.lastToolOutput, /Chat fixture/, "the real overview reached the fixture as function_call_output");
    assert.equal(fake.state.conversationsCreated, 1, "one conversation for the whole chat");
    assert.ok(fake.state.sawConversationId, "responses carry the conversation id");
    assert.match(fake.state.lastInstructions, /replay assistant/i, "instructions travel on every request");
    stream.close();
  } finally {
    await stop(daemon);
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("openai provider maps a rejected key to an unauthenticated failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-openai-401-"));
  await seedReplay(home, "replay_fixture");
  const fake = await startFakeOpenAi({ reject: true });
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(home, port, join(home, "bin-none"), {
    REPLAY_CHAT_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-bad",
    OPENAI_BASE_URL: fake.url,
  });
  try {
    const chatId = "chat-openai-0002";
    const stream = await startStream(endpoint, chatId, "replay_fixture");
    await request(endpoint, "POST", "/api/chat/message", { chat_id: chatId, text: "hello" });
    await stream.waitFor((events) => events.some((event) => event.event === "turn" && event.data.status === "failed"));
    const failed = stream.events.find((event) => event.event === "turn" && event.data.status === "failed")!;
    assert.equal(failed.data.error_code, "unauthenticated");
    assert.match(String(failed.data.error), /API key/);
    stream.close();

    // Without any key, an explicit openai provider reports why it is unavailable.
    const keylessPort = await unusedPort();
    const keyless = await startDaemon(home, keylessPort, join(home, "bin-none"), { REPLAY_CHAT_PROVIDER: "openai" });
    const keylessAvailability = await request(`http://127.0.0.1:${keylessPort}`, "GET", "/api/chat/availability");
    assert.equal(keylessAvailability.body.available, false);
    assert.equal(keylessAvailability.body.reason, "missing_api_key");
    await stop(keyless);
  } finally {
    await stop(daemon);
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * A minimal Responses API stand-in: /conversations mints ids; /responses
 * streams SSE. First call answers in text deltas; a call whose latest input
 * mentions "use the tool" emits a function_call for get_replay_overview, and
 * the follow-up (function_call_output input) answers with text.
 */
async function startFakeOpenAi(options: { reject?: boolean } = {}) {
  const state = { conversationsCreated: 0, sawConversationId: false, lastInstructions: "", lastToolOutput: "" };
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (options.reject) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Incorrect API key provided." } }));
        return;
      }
      if (request.url === "/conversations") {
        state.conversationsCreated += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `conv_${state.conversationsCreated}` }));
        return;
      }
      const body = JSON.parse(raw) as { conversation?: string; instructions?: string; input?: { role?: string; content?: string; type?: string; output?: string }[] };
      state.sawConversationId ||= Boolean(body.conversation);
      state.lastInstructions = body.instructions ?? "";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const toolOutput = body.input?.find((item) => item.type === "function_call_output");
      if (toolOutput) {
        state.lastToolOutput = toolOutput.output ?? "";
        send("response.output_item.done", { item: { type: "message", content: [{ type: "output_text", text: "tool result received" }] } });
        send("response.completed", { response: { id: "resp_3" } });
      } else if (body.input?.some((item) => String(item.content ?? "").includes("use the tool"))) {
        send("response.output_item.done", { item: { type: "function_call", call_id: "call_1", name: "get_replay_overview", arguments: "{}" } });
        send("response.completed", { response: { id: "resp_2" } });
      } else {
        send("response.output_text.delta", { delta: "Hello from " });
        send("response.output_text.delta", { delta: "the fixture." });
        send("response.output_item.done", { item: { type: "message", content: [{ type: "output_text", text: "Hello from the fixture." }] } });
        send("response.completed", { response: { id: "resp_1" } });
      }
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake OpenAI server has no port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

test("chat availability reflects a disabled config and a missing provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "replay-chat-config-"));
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
