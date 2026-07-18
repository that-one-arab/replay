import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: pnpm release:version <major.minor.patch>");
const root = resolve(import.meta.dirname, "..");
const targets = [
  "package.json",
  "packages/core/package.json",
  "packages/daemon/package.json",
  "packages/cli/package.json",
  "packages/mcp/package.json",
  "packages/playwright-launcher/package.json",
  "packages/player/package.json",
  "packages/share-server/package.json",
  "packages/demo/package.json",
  "packages/runtime/package.json",
  "plugins/rec-mcp/.codex-plugin/plugin.json",
];
for (const target of targets) {
  const path = join(root, target);
  const json = JSON.parse(await readFile(path, "utf8"));
  json.version = version;
  await writeFile(path, JSON.stringify(json, null, 2) + "\n");
}
console.log(`Updated release version to ${version}. Add the matching CHANGELOG.md entry, then run pnpm release:check.`);
