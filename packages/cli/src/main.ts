#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
// The CLI build runs immediately after core's build, including when this
// workspace has not been linked by a package manager yet.
import { exportPath, exportSession, importSession, resolveRecConfig } from "../../core/dist/index.js";

const endpoint = process.env.REC_DAEMON_URL ?? "http://127.0.0.1:7717";
const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "browser": await browser(args); break;
    case "attach": await attach(args); break;
    case "start": await start(args); break;
    case "marker": await marker(args); break;
    case "stop": await stop(args); break;
    case "status": print(await api("GET", "/api/sessions/status")); break;
    case "list": await list(); break;
    case "open": await openReplay(args[0]); break;
    case "export": await exportRecording(args); break;
    case "import": await importRecording(args); break;
    case "share": await shareRecording(args); break;
    case "config": await config(args); break;
    case "doctor": await doctor(); break;
    default: usage(command ? `Unknown command: ${command}` : undefined);
  }
} catch (error) {
  console.error(`rec: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function browser(values: string[]) {
  const action = values.shift();
  if (action !== "start" && action !== "stop") return usage("Use rec browser start|stop");
  const executable = option(values, "--executable");
  const result = await api("POST", `/api/browser/${action}`, { executable });
  print(result);
  if (action === "start") {
    console.log("\nChrome is ready for Playwright at the CDP endpoint above; it is not a replay URL.");
    console.log("Next: configure Playwright with that endpoint, navigate to your app, then run `pnpm rec start`.");
  }
}

async function attach(values: string[]) {
  const cdp = option(values, "--cdp");
  if (!cdp) return usage("rec attach requires --cdp <url>");
  print(await api("POST", "/api/attach", { cdp_endpoint: cdp }));
}

async function start(values: string[]) {
  const title = option(values, "--title");
  const maskAllInputs = flag(values, "--mask-all-inputs");
  const origins = options(values, "--origin");
  const recordCanvas = flag(values, "--record-canvas");
  print(await api("POST", "/api/sessions/start", { title, origins, maskAllInputs, recordCanvas }));
}

async function marker(values: string[]) {
  const label = values.shift();
  if (!label) return usage("rec marker requires a label");
  const placement = option(values, "--placement");
  if (placement !== undefined && placement !== "after_previous" && placement !== "before_next") return usage("Marker placement must be after_previous or before_next");
  await api("POST", "/api/sessions/marker", { label, note: option(values, "--note"), placement });
  console.log(`Marker added: ${label}`);
}

async function stop(values: string[]) {
  const result = await api("POST", "/api/sessions/stop", { outcome: option(values, "--outcome"), notes: option(values, "--notes") }) as { sessionId: string; path: string; rawDurationMs: number; activeDurationMs: number; markers: unknown[]; portable_bundle?: string };
  console.log(`Stopped ${result.sessionId}`);
  console.log(`Active ${duration(result.activeDurationMs)} of ${duration(result.rawDurationMs)} wall clock`);
  console.log(`Bundle: ${result.path}`);
  if (result.portable_bundle) console.log(`Portable: ${result.portable_bundle}`);
  console.log(`Replay: ${endpoint}/replay?id=${encodeURIComponent(result.sessionId)}`);
}

async function list() {
  const sessions = await api("GET", "/api/sessions") as { id: string; title: string; created_at: string; outcome?: string; active_duration_ms?: number; raw_duration_ms?: number }[];
  if (!sessions.length) return console.log("No local recordings.");
  for (const session of sessions) console.log(`${session.id}  ${duration(session.active_duration_ms)} / ${duration(session.raw_duration_ms)}  ${session.outcome ?? "recorded"}  ${session.title}`);
}

async function openReplay(id: string | undefined) {
  if (!id) return usage("rec open requires a session id");
  await ensureDaemon();
  console.log(`${endpoint}/replay?id=${encodeURIComponent(id)}`);
}

async function exportRecording(values: string[]) {
  const id = values.shift();
  if (!id) return usage("rec export requires a session id");
  const output = option(values, "--output") ?? exportPath(id);
  const result = await exportSession(id, resolve(output));
  console.log(`Exported ${result.sessionId} to ${result.path} (${result.fileCount} files, ${size(result.bytes)})`);
}

async function importRecording(values: string[]) {
  const input = values.shift();
  if (!input) return usage("rec import requires a .rec file");
  const result = await importSession(resolve(input));
  await ensureDaemon();
  console.log(`Imported ${result.sessionId} (${result.fileCount} files)`);
  console.log(`Replay: ${endpoint}/replay?id=${encodeURIComponent(result.sessionId)}`);
}

async function shareRecording(values: string[]) {
  const id = values.shift();
  if (!id) return usage("rec share requires a session id");
  const shareEndpoint = process.env.REC_SHARE_URL?.replace(/\/$/, "");
  if (!shareEndpoint) throw new Error("REC_SHARE_URL is required to share a recording.");
  const artifact = exportPath(id);
  if (!existsSync(artifact)) await exportSession(id, artifact);
  const response = await fetch(`${shareEndpoint}/v1/recordings`, { method: "POST", headers: { "content-type": "application/vnd.rec" }, body: await readFile(artifact) });
  const result = await response.json().catch(() => ({})) as { error?: string; shareUrl?: string };
  if (!response.ok || !result.shareUrl) throw new Error(result.error ?? "Share service did not return a share URL.");
  console.log(`Shared ${id}: ${result.shareUrl}`);
}

async function doctor() {
  const results: string[] = [];
  try { const health = await api("GET", "/health") as { cdp_endpoint?: string; state: string }; results.push(`daemon: healthy (${health.state})`); results.push(`browser: ${health.cdp_endpoint ?? "not attached"}`); } catch { results.push("daemon: unavailable (run pnpm build, then any rec command)"); }
  const home = process.env.REC_HOME ?? join(process.env.HOME ?? process.cwd(), ".rec");
  results.push(`spool: ${home}`);
  try {
    const config = await resolveRecConfig();
    results.push(`config: ${config.sources.length ? config.sources.join(", ") : "built-in defaults"}`);
    for (const warning of config.warnings) results.push(`config warning: ${warning}`);
  } catch (error) { results.push(`config: invalid (${error instanceof Error ? error.message : String(error)})`); }
  console.log(results.join("\n"));
}

async function config(values: string[]) {
  if (values[0] !== "show") return usage("Use rec config show");
  const config = await resolveRecConfig();
  print({ browser: { ...config.browser, viewport: `${config.browser.viewport.width}x${config.browser.viewport.height}` }, replay: config.replay, sources: config.sources, warnings: config.warnings });
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  await ensureDaemon();
  const response = await fetch(`${endpoint}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 204) return undefined;
  const parsed = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? response.statusText);
  return parsed;
}

async function ensureDaemon() {
  try { if ((await fetch(`${endpoint}/health`)).ok) return; } catch { /* start below */ }
  const entry = resolve(process.cwd(), "packages/daemon/dist/main.js");
  if (!existsSync(entry)) throw new Error("rec is not built. Run pnpm install && pnpm build first.");
  const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", cwd: process.cwd(), env: { ...process.env, REC_CONFIG_CWD: process.cwd() } });
  child.unref();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    try { if ((await fetch(`${endpoint}/health`)).ok) return; } catch { /* wait */ }
  }
  throw new Error("Daemon did not start on 127.0.0.1:7717");
}

function option(values: string[], name: string) { const index = values.indexOf(name); if (index < 0) return undefined; const value = values[index + 1]; values.splice(index, value === undefined ? 1 : 2); return value; }
function options(values: string[], name: string) { const found: string[] = []; for (let value = option(values, name); value; value = option(values, name)) found.push(value); return found; }
function flag(values: string[], name: string) { const index = values.indexOf(name); if (index < 0) return false; values.splice(index, 1); return true; }
function duration(ms?: number) { if (!ms) return "0s"; const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; }
function size(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
function usage(message?: string): never { if (message) console.error(message); console.error("Usage: rec browser start [--executable <path>] | browser stop | attach --cdp <url> | start [--title <text>] [--origin <url>]... [--mask-all-inputs] [--record-canvas] | marker <label> [--note <text>] [--placement after_previous|before_next] | stop [--outcome reproduced|verified|other] [--notes <text>] | status | list | open <id> | export <id> [--output <file.rec>] | import <file.rec> | share <id> | config show | doctor"); process.exit(2); }
