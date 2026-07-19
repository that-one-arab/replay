/**
 * Stdio MCP bridge for the replay chat provider. The daemon launches Codex
 * with this file registered as the `rec_replay` MCP server; every tool call
 * is proxied straight back to the daemon's /api/chat/tool endpoint so tool
 * behavior lives in one process. The bridge itself is deliberately dumb: it
 * speaks just enough JSON-RPC for Codex's MCP client, mirroring packages/mcp.
 */

type JsonObject = Record<string, unknown>;
type Request = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };

const url = argValue("--url") ?? "http://127.0.0.1:7717";
const chatId = argValue("--chat") ?? "";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  let buffered = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) queue = queue.then(() => handleLine(line));
  });
  process.stdin.on("end", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));
}

async function handleLine(line: string) {
  let request: Request;
  try { request = JSON.parse(line) as Request; } catch { return; }
  if (!request.method) return respond(request.id, undefined, { code: -32600, message: "Invalid JSON-RPC request." });
  try {
    const result = await dispatch(request.method, request.params);
    if (request.id !== undefined) respond(request.id, result);
  } catch (error) {
    if (request.id !== undefined) respond(request.id, undefined, { code: -32601, message: messageOf(error) });
  }
}

async function dispatch(method: string, params: unknown): Promise<JsonObject> {
  if (method === "initialize") {
    const requested = object(params).protocolVersion;
    return {
      protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
      // default_tools_approval_mode is Codex's capability extension; "never"
      // spares local replay tools the approval elicitation that headless
      // exec runs auto-cancel.
      capabilities: { tools: { listChanged: false, default_tools_approval_mode: "never", default_tools_enabled: true } },
      serverInfo: { name: "rec-replay-chat", version: "0.1.0" },
    };
  }
  if (method === "notifications/initialized") return {};
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: await api("GET", "/api/chat/tools") as unknown[] };
  if (method === "tools/call") {
    const call = object(params);
    const name = typeof call.name === "string" ? call.name : "";
    try {
      const value = await api("POST", "/api/chat/tool", { chat_id: chatId, name, arguments: object(call.arguments) }) as { result?: string };
      return { content: [{ type: "text", text: value.result ?? "" }] };
    } catch (error) {
      return { content: [{ type: "text", text: messageOf(error) }], isError: true };
    }
  }
  throw new Error(`Unsupported MCP method: ${method}`);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({})) as { error?: string; tools?: unknown[] };
  if (!response.ok) throw new Error(parsed.error ?? response.statusText);
  return parsed.tools ?? parsed;
}

function respond(id: Request["id"], result?: JsonObject, error?: { code: number; message: string }) {
  const message = error ? { jsonrpc: "2.0", id: id ?? null, error } : { jsonrpc: "2.0", id: id ?? null, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function object(value: unknown): JsonObject { return typeof value === "object" && value !== null ? value as JsonObject : {}; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }

run();
