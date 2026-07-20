import { pathToFileURL } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** The subset of the embedded Playwright MCP server Replay relies on. */
type EmbeddedServer = { connect(transport: LocalTransport): Promise<void>; close?: () => Promise<void> };
type EmbeddedModule = { createConnection(config?: unknown): Promise<EmbeddedServer> };

export const MANAGED_CDP_ENDPOINT = "http://127.0.0.1:9333";

export function embeddedPlaywrightEnabled() {
  return process.env.REPLAY_EMBEDDED_PLAYWRIGHT !== "0";
}

/**
 * One side of an in-process linked transport pair. It satisfies the MCP SDK
 * Transport contract the embedded server's connect() expects, without pulling
 * the SDK itself in as a dependency: messages hop to the peer on a microtask.
 */
class LocalTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private peer?: LocalTransport;

  static pair(): [LocalTransport, LocalTransport] {
    const left = new LocalTransport();
    const right = new LocalTransport();
    left.peer = right;
    right.peer = left;
    return [left, right];
  }

  async start() {}
  async send(message: JsonRpcMessage) {
    const peer = this.peer;
    queueMicrotask(() => peer?.onmessage?.(message));
  }
  async close() {
    const peer = this.peer;
    queueMicrotask(() => peer?.onclose?.());
  }
}

/**
 * An in-process MCP client for the embedded stock Playwright MCP server.
 * Replay's front end forwards browser tool traffic through it; a connection is
 * created lazily and rebuilt only when the target CDP endpoint changes.
 */
export class PlaywrightBridge {
  private server?: EmbeddedServer;
  private transport?: LocalTransport;
  private endpoint?: string;
  private connecting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();

  /** Listing never touches the browser: the embedded server builds its tool set statically. */
  async listTools(): Promise<JsonObject[]> {
    await this.ensureConnection(this.endpoint ?? MANAGED_CDP_ENDPOINT);
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools.filter(isJsonObject) : [];
  }

  async callTool(endpoint: string, name: string, argumentsValue: JsonObject): Promise<JsonObject> {
    await this.ensureConnection(endpoint);
    return this.request("tools/call", { name, arguments: argumentsValue });
  }

  private async ensureConnection(endpoint: string) {
    if (this.connecting) await this.connecting.catch(() => undefined);
    if (this.server && this.endpoint === endpoint) return;
    this.connecting = this.connect(endpoint);
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(endpoint: string) {
    await this.disconnect();
    const { createConnection } = await loadEmbeddedModule();
    const server = await createConnection({ browser: { cdpEndpoint: endpoint } });
    const [local, remote] = LocalTransport.pair();
    local.onmessage = (message) => this.receive(message);
    local.onclose = () => this.failPending(new Error("The embedded Playwright MCP connection closed."));
    await server.connect(remote);
    this.server = server;
    this.transport = local;
    this.endpoint = endpoint;
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "replay-mcp", version: "0.2.2" },
    });
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async disconnect() {
    const server = this.server;
    const transport = this.transport;
    this.server = undefined;
    this.transport = undefined;
    this.endpoint = undefined;
    this.failPending(new Error("The embedded Playwright MCP connection was replaced."));
    if (transport) await transport.close().catch(() => undefined);
    if (server?.close) await server.close().catch(() => undefined);
  }

  private receive(message: JsonRpcMessage) {
    if (message.method !== undefined) {
      // The embedded server may issue client requests (for example roots/list)
      // or notifications. Replay implements none of them; answer requests so the
      // server never awaits forever, and let notifications pass.
      if (message.id !== undefined && message.id !== null) {
        void this.transport?.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `replay-mcp does not implement ${message.method}.` } });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Embedded Playwright MCP request failed."));
    else pending.resolve(isJsonObject(message.result) ? message.result : {});
  }

  private request(method: string, params: unknown): Promise<JsonObject> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error("The embedded Playwright MCP server is not connected."));
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private failPending(error: Error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}

/**
 * REPLAY_EMBEDDED_MCP_MODULE points tests (or an adventurous user) at an
 * alternate module implementing createConnection; the default is the pinned
 * @playwright/mcp dependency.
 */
async function loadEmbeddedModule(): Promise<EmbeddedModule> {
  const override = process.env.REPLAY_EMBEDDED_MCP_MODULE;
  const specifier = override ? (override.startsWith("/") ? pathToFileURL(override).href : override) : "@playwright/mcp";
  const loaded = await import(specifier) as Partial<EmbeddedModule>;
  if (typeof loaded.createConnection !== "function") {
    throw new Error(`${specifier} does not export createConnection; Replay cannot embed Playwright MCP.`);
  }
  return loaded as EmbeddedModule;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
