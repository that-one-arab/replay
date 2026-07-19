/**
 * The replay assistant panel: a floating chat island that talks to the local
 * daemon's Codex-backed chat endpoints over SSE and executes player-control
 * tools (seek, playback, highlight, read screen) that the model requests.
 *
 * The panel lives outside #app on purpose — the player rebuilds #app's whole
 * subtree on idle-mode changes and seeks, and the conversation must survive
 * every rebuild. The playback controls it needs are re-registered by each
 * replay() instance through registerReplayControl().
 */

type ChatAvailability = { available: boolean; provider?: string; model?: string; reason?: string };

export type ReplayControl = {
  /** Seek to a raw recording time. Resolves after the new replay instance is live. */
  seek(rawMs: number, play: boolean): Promise<string>;
  setPlayback(action: "play" | "pause"): string;
  readScreen(): Promise<string>;
  highlight(args: { text?: string; selector?: string }): string;
};

type TranscriptEntry =
  | { type: "user_message"; text: string }
  | { type: "message"; text: string }
  | { type: "activity"; label: string; status: "started" | "completed" | "failed" }
  | { type: "turn"; status: "started" | "completed" | "failed" | "canceled"; error?: string; error_code?: string };

const SUGGESTIONS = [
  "What happens in this replay?",
  "Summarize the key steps",
  "Did anything go wrong?",
];

let control: ReplayControl | undefined;
let panel: HTMLElement | undefined;
let availability: ChatAvailability = { available: false };
let recordingId = "";
let chatId = "";
let source: EventSource | undefined;
let transcript: TranscriptEntry[] = [];
let streamingText = "";
let busy = false;
let connected = false;
let onOpenPanel: (() => void) | undefined;
let lastUserMessage = "";
// Transcript index of the user message being edited in place, if any.
let editingIndex: number | undefined;

export function registerReplayControl(value: ReplayControl) { control = value; }

/** Called once per page load; probes availability and prepares the panel. */
export async function initChat(id: string, onOpen?: () => void) {
  recordingId = id;
  onOpenPanel = onOpen;
  availability = await probeAvailability();
  if (!availability.available && !isSetupReason(availability.reason)) return;
  chatId = restoreChatId();
  buildPanel();
  if (availability.available) connect();
  syncToggles();
}

/** Re-wire the deck toggle after each shell re-render. */
export function wireChatToggle(button: HTMLButtonElement | null) {
  if (!button) return;
  button.onclick = () => togglePanel();
  syncToggles();
}

export function isChatOpen() { return panel?.classList.contains("is-open") === true; }

export function closeChat() { if (isChatOpen()) togglePanel(); }

async function probeAvailability(): Promise<ChatAvailability> {
  try {
    const response = await fetch("/api/chat/availability");
    if (!response.ok) return { available: false };
    return await response.json() as ChatAvailability;
  } catch { return { available: false }; }
}

/** Unavailable states worth explaining in the panel instead of hiding the feature. */
function isSetupReason(reason: string | undefined) {
  return reason === "provider_missing" || reason === "missing_api_key";
}

/** Prefer the actual model name (e.g. "GPT 5.6") over the raw provider word. */
function providerLabel() {
  if (availability.model) return formatModelLabel(availability.model);
  return availability.provider === "openai" ? "OpenAI" : "Codex";
}

function formatModelLabel(model: string) {
  const gpt = /^gpt-?(\d+(?:\.\d+)?)/i.exec(model);
  if (gpt) return `GPT ${gpt[1]}`;
  return model.replace(/[-_]+/g, " ").trim();
}

function restoreChatId() {
  const key = `rec-chat:${recordingId}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const fresh = newChatId();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch { return newChatId(); }
}

function newChatId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function togglePanel() {
  if (!panel) return;
  const open = !panel.classList.contains("is-open");
  panel.classList.toggle("is-open", open);
  document.body.classList.toggle("chat-open", open);
  if (open) {
    onOpenPanel?.();
    panel.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus();
  }
  syncToggles();
  // The stage width changes over a CSS transition; re-measure both now and once
  // it settles so the replay shrinks into its column instead of staying wide and
  // slipping behind the panel.
  window.dispatchEvent(new Event("resize"));
  window.setTimeout(() => window.dispatchEvent(new Event("resize")), 260);
}

function syncToggles() {
  const button = document.querySelector<HTMLButtonElement>("#chat-toggle");
  if (!button) return;
  button.hidden = !availability.available && !isSetupReason(availability.reason);
  button.classList.toggle("is-open", isChatOpen());
  button.setAttribute("aria-expanded", isChatOpen() ? "true" : "false");
}

function connect() {
  source?.close();
  source = new EventSource(`/api/chat/stream?chat=${encodeURIComponent(chatId)}&session=${encodeURIComponent(recordingId)}`);
  source.addEventListener("ready", (event) => {
    connected = true;
    const data = JSON.parse((event as MessageEvent).data as string) as { busy?: boolean; provider?: string; model?: string };
    if (data.provider) availability = { ...availability, provider: data.provider };
    if (data.model) availability = { ...availability, model: data.model };
    const badge = panel?.querySelector<HTMLElement>(".chat-provider");
    if (badge) badge.textContent = providerLabel();
    setBusy(Boolean(data.busy));
    setConnectionNote(undefined);
  });
  source.addEventListener("message_delta", (event) => {
    const data = JSON.parse((event as MessageEvent).data as string) as { text?: string };
    streamingText += data.text ?? "";
    renderTranscript();
  });
  source.addEventListener("history", (event) => {
    const data = JSON.parse((event as MessageEvent).data as string) as { events?: TranscriptEntry[] };
    const events = data.events ?? [];
    // A daemon restart hands back an empty transcript; keep the richer local
    // view rather than wiping the viewer's conversation off the screen.
    if (events.length >= transcript.length) { transcript = events; renderTranscript(); }
  });
  for (const type of ["user_message", "message", "activity", "turn"] as const) {
    source.addEventListener(type, (event) => {
      const entry = JSON.parse((event as MessageEvent).data as string) as TranscriptEntry;
      // A finished message (or turn boundary) supersedes the streamed preview.
      if (entry.type === "message" || entry.type === "turn") streamingText = "";
      transcript.push(entry);
      if (entry.type === "turn") setBusy(entry.status === "started");
      renderTranscript();
    });
  }
  source.addEventListener("tool_request", (event) => {
    const data = JSON.parse((event as MessageEvent).data as string) as { call_id: string; name: string; args: Record<string, unknown> };
    void runTool(data.name, data.args)
      .then((result) => postToolResult(data.call_id, true, result))
      .catch((error: unknown) => postToolResult(data.call_id, false, error instanceof Error ? error.message : String(error)));
  });
  source.onerror = () => {
    connected = false;
    setConnectionNote("Reconnecting to the recorder…");
  };
}

async function postToolResult(callId: string, ok: boolean, result: unknown) {
  await fetch("/api/chat/tool-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, call_id: callId, ok, result }),
  }).catch(() => undefined);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const live = () => {
    if (!control) throw new Error("The replay is still loading.");
    return control;
  };
  if (name === "seek") return live().seek(numberArg(args.t_ms), args.play === true);
  if (name === "set_playback") return live().setPlayback(args.action === "play" ? "play" : "pause");
  if (name === "get_screen") {
    if (typeof args.t_ms === "number") await live().seek(args.t_ms, false);
    return live().readScreen();
  }
  if (name === "highlight") {
    if (typeof args.t_ms === "number") await live().seek(args.t_ms, false);
    return live().highlight({ text: stringArg(args.text), selector: stringArg(args.selector) });
  }
  throw new Error(`The player does not support the ${name} tool.`);
}

function numberArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("A t_ms number is required.");
  return value;
}
function stringArg(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

function buildPanel() {
  if (panel) return;
  panel = document.createElement("aside");
  panel.className = "chat-panel";
  panel.setAttribute("aria-label", "Replay assistant");
  panel.innerHTML = `
    <header class="chat-header">
      <span class="chat-kicker"><i aria-hidden="true"></i>Replay assistant</span>
      <span class="chat-provider"></span>
      <button class="chat-icon-button" id="chat-reset" type="button" title="New conversation" aria-label="Start a new conversation"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg></button>
      <button class="chat-icon-button" id="chat-close" type="button" title="Close" aria-label="Close the assistant"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg></button>
    </header>
    <div class="chat-scroll" id="chat-scroll" role="log" aria-live="polite"></div>
    <p class="chat-note" id="chat-note" hidden></p>
    <form class="chat-composer" id="chat-composer">
      <textarea rows="1" placeholder="Ask about this replay…" aria-label="Ask about this replay" maxlength="8000"></textarea>
      <button class="chat-send" type="submit" aria-label="Send"><svg class="chat-send-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"></path></svg><span class="chat-stop-icon" aria-hidden="true"></span></button>
    </form>`;
  document.body.appendChild(panel);
  panel.querySelector<HTMLElement>(".chat-provider")!.textContent = providerLabel();
  panel.querySelector<HTMLButtonElement>("#chat-close")!.onclick = () => togglePanel();
  panel.querySelector<HTMLButtonElement>("#chat-reset")!.onclick = () => resetConversation();
  const form = panel.querySelector<HTMLFormElement>("#chat-composer")!;
  const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy) { void cancelTurn(); return; }
    void send(input.value);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy) void send(input.value);
    }
    event.stopPropagation();
  });
  input.addEventListener("input", () => autosizeComposer(input));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isChatOpen() && !busyTextEntry(event)) togglePanel();
  }, true);
  renderTranscript();
}

/** Grow the composer with its content, showing a scrollbar only once it hits the cap. */
function autosizeComposer(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  const capped = Math.min(input.scrollHeight, 120);
  input.style.height = `${capped}px`;
  input.style.overflowY = input.scrollHeight > 120 ? "auto" : "hidden";
}

/** Keep Escape-to-close from stealing an Escape typed while composing text elsewhere. */
function busyTextEntry(event: KeyboardEvent) {
  const target = event.target;
  return target instanceof HTMLElement && target.tagName === "TEXTAREA" && target.closest(".chat-panel") === null;
}

function resetConversation() {
  transcript = [];
  streamingText = "";
  editingIndex = undefined;
  chatId = newChatId();
  try { sessionStorage.setItem(`rec-chat:${recordingId}`, chatId); } catch { /* private browsing */ }
  setBusy(false);
  connect();
  renderTranscript();
}

function beginEdit(index: number) {
  if (busy || transcript[index]?.type !== "user_message") return;
  editingIndex = index;
  renderTranscript();
}

/** Wire the in-place edit form (autosize, save/cancel, Enter to save, Escape to cancel). */
function wireEditForm(scroll: HTMLElement) {
  const form = scroll.querySelector<HTMLFormElement>(".chat-edit-form");
  if (!form) return;
  const index = Number(form.dataset.editIndex);
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const cancel = () => { editingIndex = undefined; renderTranscript(); };
  form.onsubmit = (event) => { event.preventDefault(); void saveEdit(index, textarea.value); };
  form.querySelector<HTMLButtonElement>(".chat-edit-cancel")!.onclick = cancel;
  textarea.addEventListener("input", () => autosizeComposer(textarea));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void saveEdit(index, textarea.value); }
    else if (event.key === "Escape") { event.preventDefault(); cancel(); }
    event.stopPropagation();
  });
  autosizeComposer(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/** Resubmit an edited message; the daemon drops it and everything after, then re-answers. */
async function saveEdit(index: number, text: string) {
  const clean = text.trim();
  if (!clean || busy) return;
  if (transcript[index]?.type !== "user_message") return;
  editingIndex = undefined;
  lastUserMessage = clean;
  // Optimistically drop the edited message and everything after it so the
  // daemon's truncated history event doesn't look like a shrunk transcript.
  transcript = transcript.slice(0, index);
  streamingText = "";
  setBusy(true);
  try {
    const response = await fetch("/api/chat/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, index, text: clean }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      // A restarted daemon forgets the session and its history; there is nothing
      // left to trim, so just send the edited text into the recreated chat.
      if (/not found/i.test(body.error ?? "")) {
        connect();
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        setBusy(false);
        return send(clean);
      }
      throw new Error(body.error ?? "The assistant is unavailable right now.");
    }
  } catch (error) {
    setBusy(false);
    transcript.push({ type: "user_message", text: clean });
    transcript.push({ type: "turn", status: "failed", error: error instanceof Error ? error.message : String(error) });
    renderTranscript();
  }
}

async function send(text: string, isRetry = false) {
  const clean = text.trim();
  if (!clean || busy) return;
  if (isSetupReason(availability.reason)) return;
  lastUserMessage = clean;
  const input = panel?.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
  if (input) { input.value = ""; autosizeComposer(input); }
  setBusy(true);
  try {
    const response = await fetch("/api/chat/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: clean }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      // A restarted daemon forgets chat sessions; reconnecting recreates this
      // one, so retry once before surfacing an error.
      if (!isRetry && /not found/i.test(body.error ?? "")) {
        connect();
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        setBusy(false);
        return send(clean, true);
      }
      throw new Error(body.error ?? "The assistant is unavailable right now.");
    }
  } catch (error) {
    setBusy(false);
    transcript.push({ type: "user_message", text: clean });
    transcript.push({ type: "turn", status: "failed", error: error instanceof Error ? error.message : String(error) });
    renderTranscript();
  }
}

async function cancelTurn() {
  await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  }).catch(() => undefined);
}

function setBusy(value: boolean) {
  busy = value;
  panel?.classList.toggle("is-busy", value);
  const send = panel?.querySelector<HTMLButtonElement>(".chat-send");
  if (send) send.setAttribute("aria-label", value ? "Stop the reply" : "Send");
  renderTranscript();
}

function setConnectionNote(text: string | undefined) {
  const note = panel?.querySelector<HTMLElement>("#chat-note");
  if (!note) return;
  note.hidden = !text;
  note.textContent = text ?? "";
}

function renderTranscript() {
  const scroll = panel?.querySelector<HTMLElement>("#chat-scroll");
  if (!scroll) return;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  if (isSetupReason(availability.reason)) {
    scroll.innerHTML = availability.reason === "missing_api_key"
      ? `<div class="chat-empty"><b>No OpenAI API key</b><p>The replay assistant is set to the OpenAI API but no key is configured. Add one, then reopen this replay.</p><code>export OPENAI_API_KEY=sk-…\n# or in ~/.rec/config.toml\n[chat]\napi_key = "sk-…"</code></div>`
      : `<div class="chat-empty"><b>Codex is not installed</b><p>The replay assistant is powered by the Codex CLI. Install it and sign in, then reopen this replay.</p><code>npm install -g @openai/codex\ncodex login</code></div>`;
    panel?.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.setAttribute("disabled", "");
    panel?.querySelector<HTMLButtonElement>(".chat-send")?.setAttribute("disabled", "");
    return;
  }
  if (!transcript.length) {
    scroll.innerHTML = `<div class="chat-empty"><b>Ask about this replay</b><p>The assistant has read the whole recording and can move the player while it answers.</p><div class="chat-suggestions">${SUGGESTIONS.map((item) => `<button type="button" data-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></div>`;
    scroll.querySelectorAll<HTMLButtonElement>("[data-suggestion]").forEach((button) => {
      button.onclick = () => void send(button.dataset.suggestion ?? "");
    });
    return;
  }
  if (editingIndex !== undefined && (editingIndex >= transcript.length || transcript[editingIndex]?.type !== "user_message")) editingIndex = undefined;
  const parts: string[] = [];
  transcript.forEach((entry, index) => {
    if (entry.type === "user_message" && index === editingIndex) {
      parts.push(`<form class="chat-edit-form" data-edit-index="${index}"><textarea aria-label="Edit your message" maxlength="8000">${escapeHtml(entry.text)}</textarea><div class="chat-edit-actions"><button type="button" class="chat-edit-cancel">Cancel</button><button type="submit" class="chat-edit-save">Save</button></div></form>`);
    } else if (entry.type === "user_message") {
      const editable = !busy ? `<button type="button" class="chat-edit" data-edit-index="${index}" title="Edit message" aria-label="Edit message"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg></button>` : "";
      parts.push(`<div class="chat-turn chat-turn-user">${editable}<div class="chat-message chat-user">${escapeHtml(entry.text)}</div></div>`);
    } else if (entry.type === "message") parts.push(`<div class="chat-message chat-assistant">${renderMarkdown(entry.text)}</div>`);
    else if (entry.type === "activity") parts.push(`<div class="chat-activity${entry.status === "failed" ? " is-failed" : ""}${entry.status === "started" ? " is-running" : ""}"><i aria-hidden="true"></i>${escapeHtml(entry.label)}</div>`);
    else if (entry.type === "turn" && entry.status === "failed") parts.push(`<div class="chat-error"><b>Something went wrong</b><p>${escapeHtml(entry.error ?? "The assistant could not answer.")}</p><button type="button" class="chat-retry">Try again</button></div>`);
    else if (entry.type === "turn" && entry.status === "canceled") parts.push(`<div class="chat-activity is-failed"><i aria-hidden="true"></i>Stopped</div>`);
  });
  if (busy && streamingText) parts.push(`<div class="chat-message chat-assistant is-streaming">${renderMarkdown(streamingText)}</div>`);
  else if (busy) parts.push(`<div class="chat-thinking" aria-label="The assistant is thinking"><span></span><span></span><span></span></div>`);
  scroll.innerHTML = parts.join("");
  // Collapse stale "running" states: only the newest activity may spin.
  const running = scroll.querySelectorAll(".chat-activity.is-running");
  running.forEach((item, index) => { if (index < running.length - 1 || !busy) item.classList.remove("is-running"); });
  scroll.querySelectorAll<HTMLButtonElement>(".chat-retry").forEach((button) => {
    button.onclick = () => { if (lastUserMessage) void send(lastUserMessage); };
  });
  scroll.querySelectorAll<HTMLButtonElement>("[data-seek-ms]").forEach((button) => {
    button.onclick = () => { void control?.seek(Number(button.dataset.seekMs), false); };
  });
  scroll.querySelectorAll<HTMLButtonElement>(".chat-edit").forEach((button) => {
    button.onclick = () => beginEdit(Number(button.dataset.editIndex));
  });
  wireEditForm(scroll);
  if (editingIndex === undefined && nearBottom) scroll.scrollTop = scroll.scrollHeight;
}

/**
 * Minimal markdown for assistant replies: escape first, then re-introduce a
 * small trusted vocabulary (code, bold, italic, links, bullet lists). Times
 * like 1:24 become seek buttons so answers stay attached to the replay.
 */
function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text.trim());
  const blocks = escaped.split(/\n{2,}/).map((block) => {
    const fence = /^```(?:\w+)?\n([\s\S]*?)\n?```$/.exec(block.trim());
    if (fence) return `<pre>${fence[1]}</pre>`;
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*] /.test(line))) {
      return `<ul>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
    }
    if (lines.every((line) => /^\s*\d+[.)] /.test(line))) {
      return `<ol>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`;
    }
    return `<p>${lines.map(inlineMarkdown).join("<br>")}</p>`;
  });
  return blocks.join("");
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`)
    .replace(/\b(\d{1,2}):([0-5]\d)\b/g, (match, minutes: string, seconds: string) => {
      const ms = (Number(minutes) * 60 + Number(seconds)) * 1000;
      return `<button type="button" class="chat-time" data-seek-ms="${ms}" title="Jump to ${match}">${match}</button>`;
    });
}

function escapeHtml(value: string) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}
