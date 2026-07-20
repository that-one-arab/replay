#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const endpoint = process.env.REPLAY_DAEMON_URL ?? "http://127.0.0.1:7717";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = process.env.REPLAY_DAEMON_ENTRY ?? resolve(moduleDirectory, "../../daemon/dist/main.js");
// Replay's managed Chrome always exposes this fixed loopback CDP endpoint (see the
// daemon's browser launch). It is known before Chrome exists, so it can be handed
// to Playwright MCP up front and the actual launch deferred until first use.
const MANAGED_CDP_ENDPOINT = "http://127.0.0.1:9333";

void main().catch((error: unknown) => {
  process.stderr.write(`replay-playwright-launcher: ${messageOf(error)}\n`);
  process.exitCode = 1;
});

/**
 * A near-transparent rendezvous launcher. It forwards MCP stdio to stock
 * Playwright MCP untouched, except that it watches for the first `tools/call`
 * and provisions Replay's managed Chrome just-in-time before forwarding it. Chrome
 * therefore stays closed until the browser is actually used, while Playwright
 * and Replay still share one browser over the fixed loopback CDP endpoint.
 */
async function main() {
  await ensureDaemon();
  const daemonLease = await acquireDaemonLease();
  const command = process.env.REPLAY_PLAYWRIGHT_MCP_COMMAND ?? "npx";
  const args = playwrightArgs();
  if (args.includes("--cdp-endpoint")) throw new Error("REPLAY_PLAYWRIGHT_MCP_ARGS must not set --cdp-endpoint; Replay supplies the shared endpoint.");
  // Playwright MCP connects to the CDP endpoint lazily on its first browser tool,
  // so Chrome is not launched here. It is provisioned on the first tools/call.
  const child = spawn(command, [...args, "--cdp-endpoint", MANAGED_CDP_ENDPOINT], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.stdout?.pipe(process.stdout);
  child.stdin?.on("error", () => { /* Playwright MCP closed its input; nothing left to forward. */ });
  child.once("error", (error) => {
    process.stderr.write(`replay-playwright-launcher: could not start Playwright MCP: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", async (code) => {
    await releaseDaemonLease(daemonLease);
    process.exit(code ?? 1);
  });
  forwardStdinEnsuringBrowser(child);
}

/**
 * Forward the client's stdin to Playwright MCP line by line, launching Replay's
 * managed Chrome exactly once — just before the first `tools/call` reaches
 * Playwright MCP, which is the first moment a browser is actually needed.
 */
function forwardStdinEnsuringBrowser(child: ChildProcess) {
  let browserReady = false;
  let ensuring: Promise<void> | undefined;
  const ensureBrowserOnce = () => (ensuring ??= ensureManagedBrowser().then(() => { browserReady = true; }));
  let buffered = "";
  let queue = Promise.resolve();
  const handleLine = async (line: string) => {
    if (!browserReady && isToolCall(line)) {
      try {
        await ensureBrowserOnce();
      } catch (error) {
        ensuring = undefined; // A later tool call may retry after the user resolves the browser issue.
        const id = requestId(line);
        if (id !== undefined) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: messageOf(error) } })}\n`);
          return;
        }
      }
    }
    child.stdin?.write(`${line}\n`);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) queue = queue.then(() => handleLine(line));
  });
  process.stdin.on("end", () => {
    queue = queue.then(async () => { if (buffered) await handleLine(buffered); child.stdin?.end(); });
  });
}

async function ensureManagedBrowser() {
  const result = object(await api("POST", "/api/browser/ensure", { executable: process.env.REPLAY_BROWSER_EXECUTABLE }, false));
  if (result.browser_state === "restart_required") throw new Error("Replay browser settings changed. Stop the managed browser with `replay browser stop`, then start this task again.");
  requiredString(result.cdp_endpoint, "Replay browser CDP endpoint");
}

function isToolCall(line: string) {
  return parseMessage(line)?.method === "tools/call";
}
function requestId(line: string): string | number | undefined {
  const id = parseMessage(line)?.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}
function parseMessage(line: string): { method?: string; id?: unknown } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as { method?: string; id?: unknown }; } catch { return undefined; }
}

function playwrightArgs() {
  const configured = process.env.REPLAY_PLAYWRIGHT_MCP_ARGS;
  if (!configured) return ["-y", "@playwright/mcp@latest"];
  try {
    const value = JSON.parse(configured) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected a JSON string array.");
    return value;
  } catch (error) {
    throw new Error(`REPLAY_PLAYWRIGHT_MCP_ARGS is invalid: ${messageOf(error)}`);
  }
}

async function ensureDaemon(): Promise<JsonObject> {
  const running = await probeDaemon();
  if (running.health) return running.health;
  if (running.listening) throw new Error(portConflict());
  if (!existsSync(daemonEntry)) throw new Error("replay is not built. Run npm run build before starting the Playwright launcher.");
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", cwd: resolve(moduleDirectory, "../../.."), env: { ...process.env, REPLAY_CONFIG_CWD: process.cwd() } });
  child.unref();
  let daemonGone = false;
  child.once("exit", () => { daemonGone = true; });
  child.once("error", () => { daemonGone = true; });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    const probe = await probeDaemon();
    if (probe.health) return probe.health;
    if (probe.listening) throw new Error(portConflict());
    // A daemon that lost a startup race leaves the winner answering health
    // above; an exit with nothing listening means the daemon itself failed.
    if (daemonGone) throw new Error(`The replay daemon exited during startup. Run \`node ${daemonEntry}\` to see why.`);
  }
  throw new Error(`The replay daemon did not respond at ${endpoint} within 2.5s of spawning.`);
}

/**
 * A valid /health body is the only proof a replay daemon owns the endpoint.
 * Anything else answering there is a foreign process: spawning a daemon behind
 * it would die on the taken port, and treating it as the daemon (the old
 * response.ok check did) would misroute replay calls into it.
 */
async function probeDaemon(): Promise<{ health?: JsonObject; listening: boolean }> {
  let response: Response;
  try { response = await fetch(`${endpoint}/health`); } catch { return { listening: false }; }
  const health = object(await response.json().catch(() => undefined));
  return response.ok && health.ok === true ? { health, listening: true } : { listening: true };
}

function portConflict() {
  return `Something that is not a replay daemon is already listening at ${endpoint}. Stop that process or point REPLAY_PORT / REPLAY_DAEMON_URL at a free port.`;
}

type DaemonLease = { id: string; renewTimer: NodeJS.Timeout };

async function acquireDaemonLease(): Promise<DaemonLease | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/leases/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "replay-playwright-launcher", kind: "agent", ttl_ms: 30_000 }),
    });
    const value = await response.json().catch(() => ({})) as { lease_id?: string };
    if (!response.ok || !value.lease_id) return undefined;
    const renewTimer = setInterval(() => void renewDaemonLease(value.lease_id!), 10_000);
    renewTimer.unref();
    return { id: value.lease_id, renewTimer };
  } catch { return undefined; }
}

async function renewDaemonLease(id: string) {
  try {
    const response = await fetch(`${endpoint}/api/leases/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: id, ttl_ms: 30_000 }),
    });
    if (!response.ok) return;
  } catch { /* Lease expiry protects against a lost daemon connection. */ }
}

async function releaseDaemonLease(lease: DaemonLease | undefined) {
  if (!lease) return;
  clearInterval(lease.renewTimer);
  try {
    await fetch(`${endpoint}/api/leases/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: lease.id }),
      keepalive: true,
    });
  } catch { /* Lease expiry is the fallback when the launcher is interrupted. */ }
}

async function api(method: string, path: string, body?: unknown, ensure = true): Promise<unknown> {
  if (ensure) await ensureDaemon();
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? response.statusText);
  return parsed;
}

function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function requiredString(value: unknown, label: string) { if (typeof value !== "string" || !value) throw new Error(`${label} is required.`); return value; }
function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
