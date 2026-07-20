import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rootPackage = await readJson("package.json");
const version = validVersion(rootPackage.version, "root package");
const packages = ["core", "daemon", "cli", "mcp", "playwright-launcher", "player", "share-server", "demo", "runtime"];
for (const name of packages) {
  const value = await readJson(join("packages", name, "package.json"));
  if (value.version !== version) throw new Error(`packages/${name}/package.json is ${value.version}; expected ${version}.`);
}
const plugin = await readJson(join("plugins", "replay-mcp", ".codex-plugin", "plugin.json"));
if (plugin.version !== version) throw new Error(`Codex plugin is ${plugin.version}; expected ${version}.`);
const mcp = await readJson(join("plugins", "replay-mcp", ".mcp.json"));
// The plugin ships a single `replay` MCP server with stock Playwright embedded
// in-process (see README / docs/mcp.md) — no separate `playwright` server.
for (const name of ["replay"]) {
  const pinned = mcp.mcpServers?.[name]?.env?.REPLAY_RUNTIME_VERSION;
  if (pinned !== version) throw new Error(`Codex ${name} MCP pins runtime ${String(pinned)}; expected ${version}.`);
}
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md needs a ## [${version}] entry.`);
console.log(`Release version ${version} is consistent.`);

async function readJson(path) { return JSON.parse(await readFile(join(root, path), "utf8")); }
function validVersion(value, label) { if (typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)) return value; throw new Error(`${label} must use MAJOR.MINOR.PATCH Semantic Versioning.`); }
