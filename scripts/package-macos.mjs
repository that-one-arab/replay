import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execute } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execute);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(join(root, "packages", "runtime", "package.json"), "utf8")).version;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This release builder currently targets macOS on Apple silicon. Build on that host.");
}

const artifactName = `replay-${version}-darwin-arm64`;
const artifactsDir = join(root, ".artifacts");
await mkdir(artifactsDir, { recursive: true });
const stagingRoot = await mkdtemp(join(artifactsDir, ".staging-"));
const releaseRoot = join(stagingRoot, artifactName);
const runtimeDir = join(releaseRoot, "runtime");
const skillDir = join(releaseRoot, "skills", "replay-browser-capture");

try {
  await mkdir(releaseRoot, { recursive: true });
  await execFile("pnpm", ["--filter", "@replay/runtime", "deploy", "--legacy", "--prod", runtimeDir], { cwd: root });
  await cp(process.execPath, join(runtimeDir, "node"));
  await chmod(join(runtimeDir, "node"), 0o755);
  await mkdir(join(runtimeDir, "bin"), { recursive: true });
  await writeFile(join(runtimeDir, "bin", "replay"), wrapper("replay.mjs"), { mode: 0o755 });
  await writeFile(join(runtimeDir, "bin", "replay-mcp"), wrapper("replay-mcp.mjs"), { mode: 0o755 });
  await writeFile(join(runtimeDir, "bin", "replay-playwright-launcher"), wrapper("replay-playwright-launcher.mjs"), { mode: 0o755 });
  await pruneRuntimePayload(runtimeDir);
  // Ship the skill alongside the runtime so the installer can drop it into the
  // agent's skills directory. The rest of the plugin lives in the Codex
  // marketplace repo (docs/distribution.md); this tarball needs only the skill.
  await cp(join(root, "plugins", "replay-mcp", "skills", "replay-browser-capture"), skillDir, { recursive: true });
  await writeFile(join(releaseRoot, "VERSION"), `${version}\n`);
  const output = join(artifactsDir, `${artifactName}.tar.gz`);
  if (existsSync(output)) await rm(output);
  await execFile("tar", ["-C", stagingRoot, "-czf", output, artifactName]);
  const digest = createHash("sha256").update(await readFile(output)).digest("hex");
  await writeFile(`${output}.sha256`, `${digest}  ${artifactName}.tar.gz\n`);
  console.log(`Created ${output}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function wrapper(entry) {
  return `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/node" "$ROOT/bin/${entry}" "$@"\n`;
}

async function pruneRuntimePayload(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await pruneRuntimePayload(path);
    else if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.js")) await rm(path);
  }
}
