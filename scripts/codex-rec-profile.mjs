#!/usr/bin/env node
import { execFile as execute } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execute);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userHome = homedir();
const developmentHome = join(userHome, ".rec-dev");
const developmentPort = 7718;
const marketplaceName = "rec-dev";
const marketplaceRoot = join(developmentHome, "codex-marketplace");
const developmentPluginRoot = join(marketplaceRoot, "plugins", "rec-mcp-dev");
const marketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");

if (isMain()) void main().catch((error) => {
  process.stderr.write(`rec Codex profile: ${messageOf(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const action = process.argv[2];
  if (action === "dev") return activateDevelopment();
  if (action === "production") return activateProduction();
  if (action === "status") return printStatus();
  throw new Error("Usage: node scripts/codex-rec-profile.mjs <dev|production|status>");
}

async function activateDevelopment() {
  await assertDevelopmentBuild();
  await writeDevelopmentPlugin();
  await runCodex(["plugin", "remove", "rec-mcp@rec"], true);
  if (!await marketplaceIsConfigured()) await runCodex(["plugin", "marketplace", "add", marketplaceRoot]);
  await runCodex(["plugin", "add", `rec-mcp-dev@${marketplaceName}`]);
  console.log(`Rec development is active: ${developmentHome} on http://127.0.0.1:${developmentPort}. Open a new Codex task.`);
}

async function activateProduction() {
  await runCodex(["plugin", "remove", `rec-mcp-dev@${marketplaceName}`], true);
  await runCodex(["plugin", "add", "rec-mcp@rec"]);
  console.log("Rec production is active. Open a new Codex task.");
}

async function printStatus() {
  const output = await runCodex(["plugin", "list"]);
  const development = installedPlugin(output, `rec-mcp-dev@${marketplaceName}`);
  const production = installedPlugin(output, "rec-mcp@rec");
  console.log(JSON.stringify({
    active: development ? "development" : production ? "production" : "none",
    development: {
      plugin: `rec-mcp-dev@${marketplaceName}`,
      recHome: developmentHome,
      daemonUrl: `http://127.0.0.1:${developmentPort}`,
      source: repositoryRoot,
      sharing: "disabled",
    },
    production: {
      plugin: "rec-mcp@rec",
      recHome: join(userHome, ".rec"),
      daemonUrl: "http://127.0.0.1:7717",
      runtimeHome: join(userHome, ".rec", "runtimes"),
    },
  }, null, 2));
}

function installedPlugin(output, plugin) {
  return new RegExp(`^${escapeRegExp(plugin)}\\s+installed, enabled`, "m").test(output);
}

async function assertDevelopmentBuild() {
  for (const path of [join(repositoryRoot, "packages", "mcp", "dist", "main.js"), join(repositoryRoot, "packages", "playwright-launcher", "dist", "main.js")]) {
    try { await readFile(path); }
    catch { throw new Error(`Development build is missing ${path}. Run pnpm build first.`); }
  }
}

async function writeDevelopmentPlugin() {
  const version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  const pluginVersion = `${version}+codex.dev.${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  await rm(developmentPluginRoot, { recursive: true, force: true });
  await mkdir(join(developmentPluginRoot, ".codex-plugin"), { recursive: true });
  await cp(join(repositoryRoot, "plugins", "rec-mcp", "skills"), join(developmentPluginRoot, "skills"), { recursive: true });
  await writeJson(join(developmentPluginRoot, ".codex-plugin", "plugin.json"), developmentPluginManifest(pluginVersion));
  await writeJson(join(developmentPluginRoot, ".mcp.json"), developmentMcpConfig(repositoryRoot, developmentHome, developmentPort));
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeJson(marketplacePath, developmentMarketplace());
}

export function developmentMcpConfig(root, home, port) {
  const environment = {
    REC_HOME: home,
    REC_PORT: String(port),
    REC_DAEMON_URL: `http://127.0.0.1:${port}`,
  };
  return {
    mcpServers: {
      rec: {
        command: process.execPath,
        args: [join(root, "packages", "mcp", "dist", "main.js")],
        cwd: root,
        env: environment,
      },
      playwright: {
        command: process.execPath,
        args: [join(root, "packages", "playwright-launcher", "dist", "main.js")],
        cwd: root,
        env: environment,
      },
    },
  };
}

function developmentPluginManifest(version) {
  return {
    name: "rec-mcp-dev",
    version,
    description: "Local development build of Rec browser recordings.",
    author: { name: "Rec development" },
    skills: "./skills/",
    interface: {
      displayName: "Rec browser recordings (development)",
      shortDescription: "Use the current Rec checkout in an isolated local lane.",
      longDescription: "Runs the source build against an isolated browser and recording home.",
      developerName: "Rec development",
      category: "Productivity",
      capabilities: ["Interactive", "Write"],
      defaultPrompt: "Reproduce this browser bug and return a Rec replay using the development build.",
    },
    mcpServers: "./.mcp.json",
  };
}

function developmentMarketplace() {
  return {
    name: marketplaceName,
    interface: { displayName: "Rec development" },
    plugins: [{
      name: "rec-mcp-dev",
      source: { source: "local", path: "./plugins/rec-mcp-dev" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  };
}

async function marketplaceIsConfigured() {
  const output = await runCodex(["plugin", "marketplace", "list", "--json"]);
  try {
    const marketplaces = JSON.parse(output);
    return Array.isArray(marketplaces) && marketplaces.some((marketplace) => marketplace?.name === marketplaceName);
  } catch {
    return output.includes(`\"${marketplaceName}\"`) || output.includes(`Marketplace \`${marketplaceName}\``);
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

async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
function isMain() { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
