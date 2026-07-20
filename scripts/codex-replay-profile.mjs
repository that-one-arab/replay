#!/usr/bin/env node
import { execFile as execute } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execute);
const userHome = homedir();
const productionPlugin = "replay-mcp@replay";
const productionHome = join(userHome, ".replay");
const productionPort = 7717;

if (isMain()) void main().catch((error) => {
  process.stderr.write(`replay Codex profile: ${messageOf(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const action = process.argv[2];
  if (action === "status") return printStatus();
  if (action === "uninstall") return uninstall(process.argv.slice(3));
  throw new Error("Usage: node scripts/codex-replay-profile.mjs <status|uninstall [--purge]>");
}

async function printStatus() {
  const output = await runCodex(["plugin", "list"]);
  const installed = installedPlugin(output, productionPlugin);
  console.log(JSON.stringify({
    active: installed ? "production" : "none",
    production: {
      plugin: productionPlugin,
      replayHome: productionHome,
      daemonUrl: `http://127.0.0.1:${productionPort}`,
      runtimeHome: join(productionHome, "runtimes"),
    },
  }, null, 2));
}

async function uninstall(args) {
  const purge = args.includes("--purge");
  await stopDaemon(productionPort);
  await runCodex(["plugin", "remove", productionPlugin], true);

  if (!purge) {
    console.log("Removed the Replay plugin and stopped its daemon.");
    console.log("Saved replays, the Chrome profile, and downloaded runtimes were kept.");
    console.log(`To reclaim that data too, re-run with --purge, or: rm -rf ${productionHome}`);
    return;
  }

  await rm(productionHome, { recursive: true, force: true });
  console.log(`Removed Replay plugin, daemon, and data (${productionHome}).`);
  console.log("Replay is fully uninstalled.");
}

// POST the daemon's own shutdown endpoint. Best-effort: nothing listening, a
// capture in flight, or a non-Replay process on the port all resolve to false.
async function stopDaemon(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/daemon/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function runCodex(args, ignoreFailure = false) {
  try {
    const result = await execFile("codex", args, { encoding: "utf8" });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    return result.stdout;
  } catch (error) {
    if (!ignoreFailure) throw error;
    const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
    if (stderr) process.stderr.write(stderr);
    return "";
  }
}

export function installedPlugin(output, plugin) {
  return new RegExp(`^${escapeRegExp(plugin)}\\s+installed, enabled`, "m").test(output);
}

function isMain() { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
