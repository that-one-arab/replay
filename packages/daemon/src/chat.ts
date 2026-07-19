import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { renderSummaryText, sessionPath, stepsInRange, summarizeReplay, type ChatConfig, type RecordingManifest, type ReplaySummary } from "@rec/core";

/**
 * The replay chat backend. One ChatSession per open player panel, answered by
 * one of two providers chosen per turn from config:
 *
 * - "openai": the OpenAI Responses API called directly (hand-rolled fetch +
 *   SSE, matching this repo's zero-dependency style). Conversation state
 *   lives in an OpenAI Conversations object; text streams to the panel as
 *   deltas; tool calls run through the same executor as the Codex path.
 * - "codex": the Codex CLI (`codex exec --json`), resuming one Codex thread
 *   across turns, reaching back into the replay through a stdio MCP bridge.
 *
 * Player-facing tools (seek, highlight, read the screen) travel to the player
 * over the chat's SSE stream and return through /api/chat/tool-result.
 */

const TURN_STALL_TIMEOUT_MS = 180_000;
const OPENAI_DEFAULT_MODEL = "gpt-5.6-terra";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Ceiling on tool-call rounds within one turn; a chat answer never needs more. */
const MAX_TOOL_ROUNDS = 8;
const UI_TOOL_TIMEOUT_MS = 15_000;
const ORPHANED_CHAT_TTL_MS = 30 * 60_000;
const MAX_CHATS = 20;
const SCREEN_TEXT_LIMIT = 6_000;

export type ChatEvent =
  | { type: "user_message"; text: string }
  | { type: "message"; text: string }
  | { type: "activity"; label: string; status: "started" | "completed" | "failed" }
  | { type: "turn"; status: "started" | "completed" | "failed" | "canceled"; error?: string; error_code?: string };

type PendingUiCall = { resolve: (value: unknown) => void; timer: NodeJS.Timeout };

type ActiveTurn = { canceled: boolean; stop(): void };

type CodexTurn = ActiveTurn & { child: ChildProcess; stallTimer?: NodeJS.Timeout; sawCompletion: boolean; stderr: string };

type ChatSession = {
  id: string;
  recordingId: string;
  /** Codex CLI thread id, for `codex exec resume`. */
  threadId?: string;
  /** OpenAI Conversations object id. */
  conversationId?: string;
  turn?: ActiveTurn;
  clients: Set<ServerResponse>;
  pendingUiCalls: Map<string, PendingUiCall>;
  history: ChatEvent[];
  summary?: ReplaySummary;
  lastSeenAt: number;
};

type ProviderSelection = {
  provider: "codex" | "openai";
  command: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
};

type OpenAiFunctionCall = { call_id: string; name: string; arguments: string };

/**
 * Tool definitions live here so the stdio bridge can fetch one source of
 * truth. The annotations and execution.approval_mode metadata matter: Codex
 * gates un-annotated MCP tools behind an approval elicitation that headless
 * `codex exec` auto-cancels, so every tool declares itself local and safe.
 */
const SAFE_READ = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { approval_mode: "never" } } as const;
const SAFE_CONTROL = { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { approval_mode: "never" } } as const;
export const CHAT_TOOLS = [
  {
    name: "get_replay_overview",
    description: "Re-read the recording's distilled action timeline (titles, markers, navigations, clicks, typing, idle gaps) with raw t_ms values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...SAFE_READ,
  },
  {
    name: "get_steps",
    description: "List every recorded step between two raw recording times, un-elided. Use when the overview thinned a busy stretch or you need exact detail around a moment.",
    inputSchema: {
      type: "object",
      properties: {
        from_ms: { type: "number", description: "Window start in raw recording milliseconds" },
        to_ms: { type: "number", description: "Window end in raw recording milliseconds" },
      },
      required: ["from_ms", "to_ms"],
      additionalProperties: false,
    },
    ...SAFE_READ,
  },
  {
    name: "get_screen",
    description: "Read the rendered page as the viewer sees it in the replay: seeks the player (paused) to a time and returns the page URL and visible text. Omit t_ms to read wherever the viewer currently is.",
    inputSchema: {
      type: "object",
      properties: { t_ms: { type: "number", description: "Raw recording time to inspect; omit for the current playhead" } },
      additionalProperties: false,
    },
    ...SAFE_READ,
  },
  {
    name: "seek",
    description: "Move the viewer's playhead to a raw recording time so they see the moment you are describing.",
    inputSchema: {
      type: "object",
      properties: {
        t_ms: { type: "number", description: "Raw recording time to jump to" },
        play: { type: "boolean", description: "Resume playback after the jump (default: stay paused)" },
      },
      required: ["t_ms"],
      additionalProperties: false,
    },
    ...SAFE_CONTROL,
  },
  {
    name: "set_playback",
    description: "Play or pause the replay for the viewer.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["play", "pause"] } },
      required: ["action"],
      additionalProperties: false,
    },
    ...SAFE_CONTROL,
  },
  {
    name: "highlight",
    description: "Visually highlight an element on the replayed page for the viewer, optionally seeking to a time first. Match by visible text or a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text of the element to highlight" },
        selector: { type: "string", description: "CSS selector, if text is ambiguous" },
        t_ms: { type: "number", description: "Seek here before highlighting" },
      },
      additionalProperties: false,
    },
    ...SAFE_CONTROL,
  },
] as const;

const UI_TOOLS = new Set(["get_screen", "seek", "set_playback", "highlight"]);

/** The same tools in the Responses API's flat function shape. */
const OPENAI_TOOLS = CHAT_TOOLS.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
}));

export class ChatManager {
  private readonly chats = new Map<string, ChatSession>();
  private readonly config: () => Promise<ChatConfig>;
  private readonly port: number;
  private availabilityProbe?: { available: boolean; reason?: string; version?: string };

  constructor(port: number, config: () => Promise<ChatConfig>) {
    this.port = port;
    this.config = config;
  }

  /** "auto" prefers the OpenAI API when a key is configured, else the Codex CLI. */
  private selectProvider(config: ChatConfig): ProviderSelection {
    const apiKey = config.api_key || process.env.REC_CHAT_API_KEY || process.env.OPENAI_API_KEY || undefined;
    const baseUrl = (process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
    const provider = config.provider === "auto" ? (apiKey ? "openai" : "codex") : config.provider;
    return { provider, command: config.command, ...(config.model ? { model: config.model } : {}), ...(apiKey ? { apiKey } : {}), baseUrl };
  }

  /** Availability is config + credentials/binary presence; deeper auth failures surface per-turn. */
  async availability() {
    const config = await this.config();
    const selection = this.selectProvider(config);
    if (!config.enabled) return { available: false, provider: selection.provider, reason: "disabled" };
    if (selection.provider === "openai") {
      return selection.apiKey
        ? { available: true, provider: "openai", model: selection.model ?? OPENAI_DEFAULT_MODEL }
        : { available: false, provider: "openai", reason: "missing_api_key" };
    }
    if (!this.availabilityProbe || this.availabilityProbe.reason === "provider_missing") {
      this.availabilityProbe = commandOnPath(config.command)
        ? { available: true }
        : { available: false, reason: "provider_missing" };
    }
    return { available: this.availabilityProbe.available, provider: "codex", command: config.command, ...(config.model ? { model: config.model } : {}), ...(this.availabilityProbe.reason ? { reason: this.availabilityProbe.reason } : {}) };
  }

  /** SSE attach; creates the chat on first connect and replays its transcript. */
  async connect(chatId: string, recordingId: string, response: ServerResponse) {
    if (!existsSync(sessionPath(recordingId))) throw new Error(`Recording ${recordingId} was not found.`);
    const chat = this.ensure(chatId, recordingId);
    const selection = this.selectProvider(await this.config());
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`retry: 2000\n\n`);
    chat.clients.add(response);
    const model = selection.provider === "openai" ? (selection.model ?? OPENAI_DEFAULT_MODEL) : selection.model;
    sendEvent(response, "ready", { chat_id: chat.id, provider: selection.provider, ...(model ? { model } : {}), busy: Boolean(chat.turn) });
    sendEvent(response, "history", { events: chat.history });
    const heartbeat = setInterval(() => response.write(`: ping\n\n`), 25_000);
    heartbeat.unref();
    response.on("close", () => {
      clearInterval(heartbeat);
      chat.clients.delete(response);
      chat.lastSeenAt = Date.now();
    });
  }

  async message(chatId: string, text: string) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error("Chat session was not found. Reload the replay.");
    if (chat.turn) throw new Error("The assistant is still answering. Wait for the reply or stop it first.");
    const clean = text.trim();
    if (!clean) throw new Error("Message text is required.");
    if (clean.length > 8_000) throw new Error("Message is too long.");
    const config = await this.config();
    if (!config.enabled) throw new Error("Chat is disabled in the Rec config.");
    const selection = this.selectProvider(config);
    if (selection.provider === "openai" && !selection.apiKey) throw new Error("No OpenAI API key is configured. Set OPENAI_API_KEY or chat.api_key.");
    this.record(chat, { type: "user_message", text: clean });
    this.record(chat, { type: "turn", status: "started" });
    if (selection.provider === "openai") {
      void this.runOpenAiTurn(chat, selection, clean);
    } else {
      const prompt = chat.threadId ? clean : `${await this.assistantPreamble(chat)}\n\nViewer's question: ${clean}`;
      await this.runCodexTurn(chat, selection, prompt);
    }
    return { accepted: true };
  }

  cancel(chatId: string) {
    const chat = this.chats.get(chatId);
    const turn = chat?.turn;
    if (!chat || !turn) return { canceled: false };
    turn.canceled = true;
    turn.stop();
    return { canceled: true };
  }

  /** Entry point for the stdio bridge: run one tool call and return its text result. */
  async tool(chatId: string, name: string, args: Record<string, unknown>) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error("Chat session is gone.");
    if (!CHAT_TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool ${name}`);
    if (UI_TOOLS.has(name)) return this.uiTool(chat, name, args);
    const summary = await this.summaryFor(chat);
    if (name === "get_replay_overview") return renderSummaryText(summary);
    if (name === "get_steps") {
      const from = numberArg(args.from_ms, "from_ms");
      const to = numberArg(args.to_ms, "to_ms");
      const steps = stepsInRange(summary, Math.min(from, to), Math.max(from, to));
      if (!steps.length) return `No recorded steps between ${Math.round(from)}ms and ${Math.round(to)}ms.`;
      return steps.map((step) => `- [t_ms=${Math.round(step.t_ms)}] ${step.description}${step.detail && step.kind !== "input" ? ` (${step.detail})` : ""}`).join("\n");
    }
    throw new Error(`Unknown tool ${name}`);
  }

  /** The player answering a relayed UI tool call. */
  toolResult(chatId: string, callId: string, ok: boolean, result: unknown) {
    const pending = this.chats.get(chatId)?.pendingUiCalls.get(callId);
    if (!pending) return { accepted: false };
    this.chats.get(chatId)!.pendingUiCalls.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(ok ? result : new Error(typeof result === "string" ? result : "The player could not run the action."));
    return { accepted: true };
  }

  dispose() {
    for (const chat of this.chats.values()) {
      chat.turn?.stop();
      for (const client of chat.clients) client.end();
    }
    this.chats.clear();
  }

  private ensure(chatId: string, recordingId: string) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(chatId)) throw new Error("Chat id must be 8-64 url-safe characters.");
    let chat = this.chats.get(chatId);
    if (chat && chat.recordingId !== recordingId) throw new Error("Chat id is already bound to another recording.");
    if (!chat) {
      this.evictStale();
      chat = { id: chatId, recordingId, clients: new Set(), pendingUiCalls: new Map(), history: [], lastSeenAt: Date.now() };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  private evictStale() {
    const now = Date.now();
    for (const [id, chat] of this.chats) {
      const stale = !chat.clients.size && !chat.turn && now - chat.lastSeenAt > ORPHANED_CHAT_TTL_MS;
      if (stale) this.chats.delete(id);
    }
    while (this.chats.size >= MAX_CHATS) {
      const idle = [...this.chats.values()].filter((chat) => !chat.clients.size && !chat.turn).sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!idle) break;
      this.chats.delete(idle.id);
    }
  }

  private record(chat: ChatSession, event: ChatEvent) {
    chat.history.push(event);
    if (chat.history.length > 500) chat.history.splice(0, chat.history.length - 500);
    this.broadcast(chat, event.type, event);
  }

  /** Transient panel events (streaming deltas) that never enter the transcript. */
  private broadcast(chat: ChatSession, event: string, data: unknown) {
    for (const client of chat.clients) sendEvent(client, event, data);
  }

  private async assistantPreamble(chat: ChatSession) {
    const summary = await this.summaryFor(chat);
    return [
      "You are Rec's replay assistant, embedded in the player for a finished browser-session recording. The viewer is watching the replay next to this chat. Help them understand what happened: answer questions, explain failures, and point at moments.",
      "",
      "You have tools to inspect and control the player:",
      "- get_screen reads the rendered page text at any time (the most reliable way to know what was on screen).",
      "- seek, set_playback, and highlight change what the viewer sees. When you reference a moment, seek there so the viewer is looking at it; when you reference an element, highlight it.",
      "- get_steps zooms into a time range when the timeline below is too coarse.",
      "",
      "Rules:",
      "- The timeline lists times as [m:ss] with exact t_ms values; pass t_ms numbers to tools and write m:ss in prose.",
      "- This is a narrow chat panel: keep answers short, concrete, and grounded in the recording. Never invent steps that are not in the timeline or on screen.",
      "- The recording is immutable history; you control only the playback.",
      "",
      "<replay_context>",
      renderSummaryText(summary),
      "</replay_context>",
    ].join("\n");
  }

  private async summaryFor(chat: ChatSession) {
    if (chat.summary) return chat.summary;
    const root = sessionPath(chat.recordingId);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RecordingManifest;
    const eventsBySegment = new Map<string, unknown[]>();
    for (const segment of manifest.segments) {
      const events: unknown[] = [];
      for (const chunk of segment.chunks) {
        const text = gunzipSync(await readFile(join(root, chunk))).toString("utf8");
        for (const line of text.trim().split("\n")) if (line) events.push((JSON.parse(line) as { event: unknown }).event);
      }
      eventsBySegment.set(segment.id, events);
    }
    chat.summary = summarizeReplay(manifest, eventsBySegment);
    return chat.summary;
  }

  private uiTool(chat: ChatSession, name: string, args: Record<string, unknown>) {
    if (!chat.clients.size) throw new Error("The replay player is not connected, so playback tools are unavailable right now.");
    const callId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        chat.pendingUiCalls.delete(callId);
        reject(new Error("The player did not respond in time."));
      }, UI_TOOL_TIMEOUT_MS);
      timer.unref();
      chat.pendingUiCalls.set(callId, {
        timer,
        resolve: (value) => {
          if (value instanceof Error) return reject(value);
          resolve(clipScreenText(typeof value === "string" ? value : JSON.stringify(value ?? { ok: true })));
        },
      });
      for (const client of chat.clients) sendEvent(client, "tool_request", { call_id: callId, name, args });
    });
  }

  private async runCodexTurn(chat: ChatSession, selection: ProviderSelection, prompt: string) {
    const bridge = bridgePath();
    // `codex exec resume` accepts only a subset of exec's flags, so everything
    // a resumed turn still needs travels as -c config overrides instead.
    const args = [
      "exec",
      ...(chat.threadId ? ["resume", chat.threadId] : []),
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-c", `sandbox_mode="read-only"`,
      "-c", `mcp_servers.rec_replay.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.rec_replay.args=[${JSON.stringify(bridge)}, "--url", ${JSON.stringify(`http://127.0.0.1:${this.port}`)}, "--chat", ${JSON.stringify(chat.id)}]`,
      ...(chat.threadId ? [] : ["-C", sessionPath(chat.recordingId), ...(selection.model ? ["-m", selection.model] : [])]),
      prompt,
    ];
    let child: ChildProcess;
    try {
      child = spawn(selection.command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      this.finishTurn(chat, "failed", messageOf(error), "spawn_failed");
      return;
    }
    const turn: CodexTurn = { child, canceled: false, sawCompletion: false, stderr: "", stop: () => stopChild(child) };
    chat.turn = turn;
    const stall = () => {
      if (turn.stallTimer) clearTimeout(turn.stallTimer);
      turn.stallTimer = setTimeout(() => { turn.stderr ||= "The provider stopped responding."; stopChild(child); }, TURN_STALL_TIMEOUT_MS);
      turn.stallTimer.unref();
    };
    stall();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => { turn.stderr = (turn.stderr + data).slice(-4_000); });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      stall();
      const event = parseJson(line);
      if (event) this.onProviderEvent(chat, turn, event);
    });
    child.on("error", (error) => {
      if (chat.turn !== turn) return;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.finishTurn(chat, "failed", missing ? `The chat provider "${selection.command}" was not found on PATH.` : messageOf(error), missing ? "provider_missing" : "spawn_failed");
      if (missing) this.availabilityProbe = { available: false, reason: "provider_missing" };
    });
    child.on("close", (code) => {
      if (chat.turn !== turn) return;
      if (turn.stallTimer) clearTimeout(turn.stallTimer);
      if (turn.canceled) return this.finishTurn(chat, "canceled");
      if (turn.sawCompletion) return this.finishTurn(chat, "completed");
      this.finishTurn(chat, "failed", turnFailureMessage(code, turn.stderr), turnFailureCode(turn.stderr));
    });
  }

  private onProviderEvent(chat: ChatSession, turn: CodexTurn, event: Record<string, unknown>) {
    const type = String(event.type ?? "");
    if (type === "thread.started" && typeof event.thread_id === "string") chat.threadId = event.thread_id;
    if (type === "turn.completed") turn.sawCompletion = true;
    if (type === "turn.failed") {
      const error = event.error as { message?: string } | undefined;
      turn.stderr = error?.message ?? turn.stderr;
    }
    // Activities are recorded on completion only — one chip per action; the
    // panel's thinking indicator already covers "in progress".
    if (type !== "item.completed") return;
    const item = event.item as { type?: string; text?: string; command?: string; server?: string; tool?: string; query?: string; status?: string } | undefined;
    if (!item?.type) return;
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      this.record(chat, { type: "message", text: item.text });
      return;
    }
    const label = activityLabel(item);
    if (label) this.record(chat, { type: "activity", label, status: item.status === "failed" ? "failed" : "completed" });
  }

  /**
   * One OpenAI turn: stream a response, resolve any tool calls, repeat until
   * the model answers in text. Conversation state lives server-side in an
   * OpenAI Conversations object (no 30-day response TTL, no id threading);
   * the preamble travels as `instructions` each request since Responses does
   * not carry instructions across a chain.
   */
  private async runOpenAiTurn(chat: ChatSession, selection: ProviderSelection, text: string) {
    const controller = new AbortController();
    const turn: ActiveTurn = { canceled: false, stop: () => controller.abort() };
    chat.turn = turn;
    try {
      if (!chat.conversationId) {
        const conversation = await this.openAiRequest(selection, "/conversations", {}, controller.signal) as { id?: string };
        if (!conversation.id) throw new Error("OpenAI did not return a conversation id.");
        chat.conversationId = conversation.id;
      }
      const instructions = await this.assistantPreamble(chat);
      let input: unknown[] = [{ role: "user", content: text }];
      for (let round = 0; ; round += 1) {
        const calls = await this.streamOpenAiResponse(chat, selection, instructions, input, controller.signal);
        if (!calls.length) break;
        if (round >= MAX_TOOL_ROUNDS) throw new Error("The assistant tried to use too many tool calls in one answer.");
        input = [];
        // Sequential on purpose: seek-then-read orderings matter in the player.
        for (const call of calls) {
          const output = await this.tool(chat.id, call.name, parseArguments(call.arguments))
            .then((result) => {
              this.record(chat, { type: "activity", label: friendlyToolLabel(call.name), status: "completed" });
              return result;
            })
            .catch((error: unknown) => {
              this.record(chat, { type: "activity", label: friendlyToolLabel(call.name), status: "failed" });
              return `Error: ${messageOf(error)}`;
            });
          input.push({ type: "function_call_output", call_id: call.call_id, output });
        }
      }
      if (chat.turn !== turn) return;
      this.finishTurn(chat, "completed");
    } catch (error) {
      if (chat.turn !== turn) return;
      if (turn.canceled) return this.finishTurn(chat, "canceled");
      this.finishTurn(chat, "failed", openAiFailureMessage(error), openAiFailureCode(error));
    }
  }

  /** Stream one /responses call; emit text deltas to the panel, return tool calls. */
  private async streamOpenAiResponse(chat: ChatSession, selection: ProviderSelection, instructions: string, input: unknown[], signal: AbortSignal): Promise<OpenAiFunctionCall[]> {
    const response = await fetch(`${selection.baseUrl}/responses`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${selection.apiKey}` },
      body: JSON.stringify({
        model: selection.model ?? OPENAI_DEFAULT_MODEL,
        conversation: chat.conversationId,
        instructions,
        input,
        tools: OPENAI_TOOLS,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new OpenAiError(response.status, body.error?.message ?? `OpenAI returned HTTP ${response.status}.`);
    }
    const calls: OpenAiFunctionCall[] = [];
    let completed = false;
    let failure: string | undefined;
    const onFrame = (eventName: string, data: Record<string, unknown>) => {
      if (eventName === "response.output_text.delta" && typeof data.delta === "string") {
        this.broadcast(chat, "message_delta", { text: data.delta });
        return;
      }
      if (eventName === "response.output_item.done") {
        const item = data.item as { type?: string; call_id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string }[] } | undefined;
        if (item?.type === "function_call" && item.call_id && item.name) calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
        if (item?.type === "message") {
          const text = (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
          if (text.trim()) this.record(chat, { type: "message", text });
        }
        return;
      }
      if (eventName === "response.completed") completed = true;
      if (eventName === "response.failed" || eventName === "error") {
        const detail = (data.response as { error?: { message?: string } } | undefined)?.error?.message ?? (data as { message?: string }).message;
        failure = detail ?? "The model run failed.";
      }
    };
    await readSseStream(response.body, onFrame, signal);
    if (failure) throw new Error(failure);
    if (!completed) throw new Error("OpenAI ended the stream before completing the response.");
    return calls;
  }

  private async openAiRequest(selection: ProviderSelection, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${selection.baseUrl}${path}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${selection.apiKey}` },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) throw new OpenAiError(response.status, parsed.error?.message ?? `OpenAI returned HTTP ${response.status}.`);
    return parsed;
  }

  private finishTurn(chat: ChatSession, status: "completed" | "failed" | "canceled", error?: string, errorCode?: string) {
    chat.turn = undefined;
    for (const [callId, pending] of chat.pendingUiCalls) {
      clearTimeout(pending.timer);
      pending.resolve(new Error("The turn ended."));
      chat.pendingUiCalls.delete(callId);
    }
    this.record(chat, { type: "turn", status, ...(error ? { error } : {}), ...(errorCode ? { error_code: errorCode } : {}) });
  }
}

function activityLabel(item: { type?: string; command?: string; server?: string; tool?: string; query?: string; text?: string }) {
  if (item.type === "mcp_tool_call") return friendlyToolLabel(item.tool ?? "tool");
  if (item.type === "command_execution") return item.command ? `Ran ${clipLabel(item.command)}` : "Ran a command";
  if (item.type === "web_search") return item.query ? `Searched the web for ${clipLabel(item.query)}` : "Searched the web";
  if (item.type === "reasoning") return "Thinking";
  return undefined;
}

function friendlyToolLabel(tool: string) {
  const name = tool.split("__").at(-1) ?? tool;
  const labels: Record<string, string> = {
    get_replay_overview: "Reviewed the timeline",
    get_steps: "Inspected a time range",
    get_screen: "Read the screen",
    seek: "Moved the playhead",
    set_playback: "Controlled playback",
    highlight: "Highlighted an element",
  };
  return labels[name] ?? `Used ${name}`;
}

function turnFailureMessage(code: number | null, stderr: string) {
  const clean = stderr.trim().split("\n").filter((line) => line && !line.startsWith("zoxide:")).slice(-3).join(" ").trim();
  if (turnFailureCode(stderr) === "unauthenticated") return "Codex is not signed in. Run `codex login` in a terminal, then try again.";
  if (clean) return clipLabel(clean, 300);
  return `The chat provider exited unexpectedly (code ${code ?? "unknown"}).`;
}

function turnFailureCode(stderr: string) {
  return /not logged in|login required|codex login|unauthorized|401/i.test(stderr) ? "unauthenticated" : undefined;
}

class OpenAiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function openAiFailureMessage(error: unknown) {
  if (error instanceof OpenAiError && error.status === 401) return "OpenAI rejected the API key. Check chat.api_key or OPENAI_API_KEY, then try again.";
  if (error instanceof OpenAiError && error.status === 429) return `OpenAI rate limit or quota reached: ${error.message}`;
  return clipLabel(messageOf(error), 300);
}

function openAiFailureCode(error: unknown) {
  if (error instanceof OpenAiError && error.status === 401) return "unauthenticated";
  if (error instanceof OpenAiError && error.status === 429) return "rate_limited";
  return undefined;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Minimal SSE consumer: split frames on blank lines, surface event + parsed data. */
async function readSseStream(body: ReadableStream<Uint8Array>, onFrame: (event: string, data: Record<string, unknown>) => void, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      let stallTimer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => {
          reject(new Error("The model stream stalled."));
          void reader.cancel().catch(() => undefined);
        }, TURN_STALL_TIMEOUT_MS);
        stallTimer.unref();
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(stallTimer);
      }
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        let eventName = "";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!eventName || !dataLines.length) continue;
        try {
          onFrame(eventName, JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
        } catch { /* a malformed frame is skipped, not fatal */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw new Error("Canceled.");
}

function bridgePath() {
  return join(dirname(fileURLToPath(import.meta.url)), "chat-bridge.js");
}

function commandOnPath(command: string) {
  if (command.includes("/")) return existsSync(command);
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

function sendEvent(client: ServerResponse, event: string, data: unknown) {
  client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function clipScreenText(value: string) {
  return value.length > SCREEN_TEXT_LIMIT ? `${value.slice(0, SCREEN_TEXT_LIMIT)}\n(… truncated)` : value;
}

function clipLabel(value: string, limit = 90) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function numberArg(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number of milliseconds.`);
  return value;
}

function parseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { return undefined; }
}

function stopChild(child: ChildProcess) {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const hardKill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2_000);
  hardKill.unref();
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
