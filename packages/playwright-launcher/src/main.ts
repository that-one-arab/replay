#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const endpoint = process.env.REC_DAEMON_URL ?? "http://127.0.0.1:7717";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = process.env.REC_DAEMON_ENTRY ?? resolve(moduleDirectory, "../../daemon/dist/main.js");

void main().catch((error: unknown) => {
  process.stderr.write(`rec-playwright-launcher: ${messageOf(error)}\n`);
  process.exitCode = 1;
});

/**
 * A stdio-transparent rendezvous launcher. It never handles MCP messages: once
 * Rec has provisioned its Chrome, stock Playwright MCP owns stdin/stdout.
 */
async function main() {
  await ensureDaemon();
  const daemonLease = await acquireDaemonLease();
  const ensured = object(await api("POST", "/api/browser/ensure", { executable: process.env.REC_BROWSER_EXECUTABLE }, false));
  if (ensured.browser_state === "restart_required") throw new Error("Rec browser settings changed. Stop the managed browser with `rec browser stop`, then start this task again.");
  const cdpEndpoint = requiredString(ensured.cdp_endpoint, "Rec browser CDP endpoint");
  const command = process.env.REC_PLAYWRIGHT_MCP_COMMAND ?? "npx";
  const args = playwrightArgs();
  if (args.includes("--cdp-endpoint")) throw new Error("REC_PLAYWRIGHT_MCP_ARGS must not set --cdp-endpoint; Rec supplies the shared endpoint.");
  const child = spawn(command, [...args, "--cdp-endpoint", cdpEndpoint], { stdio: "inherit", env: process.env });
  child.once("error", (error) => {
    process.stderr.write(`rec-playwright-launcher: could not start Playwright MCP: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", async (code) => {
    await releaseDaemonLease(daemonLease);
    process.exitCode = code ?? 1;
  });
}

function playwrightArgs() {
  const configured = process.env.REC_PLAYWRIGHT_MCP_ARGS;
  if (!configured) return ["-y", "@playwright/mcp@latest"];
  try {
    const value = JSON.parse(configured) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected a JSON string array.");
    return value;
  } catch (error) {
    throw new Error(`REC_PLAYWRIGHT_MCP_ARGS is invalid: ${messageOf(error)}`);
  }
}

async function ensureDaemon(): Promise<JsonObject> {
  try { return object(await api("GET", "/health", undefined, false)); } catch { /* launch below */ }
  if (!existsSync(daemonEntry)) throw new Error("rec is not built. Run npm run build before starting the Playwright launcher.");
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", cwd: resolve(moduleDirectory, "../../.."), env: { ...process.env, REC_CONFIG_CWD: process.cwd() } });
  child.unref();
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    try { return object(await api("GET", "/health", undefined, false)); } catch (error) { lastError = error; }
  }
  throw new Error(`Rec daemon did not start: ${messageOf(lastError)}`);
}

type DaemonLease = { id: string; renewTimer: NodeJS.Timeout };

async function acquireDaemonLease(): Promise<DaemonLease | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/leases/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "rec-playwright-launcher", kind: "agent", ttl_ms: 30_000 }),
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
