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
const pluginDir = join(releaseRoot, "plugin", "replay-mcp");

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
  await cp(join(root, "plugins", "replay-mcp"), pluginDir, { recursive: true });
  await writeFile(join(releaseRoot, "VERSION"), `${version}\n`);
  await writeFile(join(releaseRoot, "marketplace.json"), JSON.stringify(marketplace(), null, 2) + "\n");
  await writeFile(join(releaseRoot, "install.sh"), installer(), { mode: 0o755 });
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

function marketplace() {
  return {
    name: "replay",
    interface: { displayName: "Replay" },
    plugins: [{
      name: "replay-mcp",
      source: { source: "local", path: "./plugins/replay-mcp" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  };
}

function installer() {
  return `#!/bin/sh
set -eu

SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(tr -d '\\r\\n' < "$SOURCE/VERSION")
REPLAY_INSTALL_ROOT=\${REPLAY_INSTALL_ROOT:-"$HOME/.replay"}
RUNTIME_DIR="$REPLAY_INSTALL_ROOT/runtimes/$VERSION"
PLUGIN_DIR="$REPLAY_INSTALL_ROOT/plugins/replay-mcp"

if [ -e "$RUNTIME_DIR" ]; then
  echo "Replay $VERSION is already installed at $RUNTIME_DIR" >&2
  exit 1
fi

mkdir -p "$REPLAY_INSTALL_ROOT/runtimes" "$REPLAY_INSTALL_ROOT/plugins"
cp -R "$SOURCE/runtime" "$RUNTIME_DIR"

if [ -e "$PLUGIN_DIR" ]; then
  BACKUP="$REPLAY_INSTALL_ROOT/plugins/replay-mcp.backup.$(date +%Y%m%d%H%M%S)"
  mv "$PLUGIN_DIR" "$BACKUP"
  echo "Previous Codex plugin moved to $BACKUP"
fi
cp -R "$SOURCE/plugin/replay-mcp" "$PLUGIN_DIR"
ESCAPED_RUNTIME_DIR=$(printf '%s' "$RUNTIME_DIR" | sed 's/[\\\\&|]/\\\\&/g')
sed "s|__REPLAY_RUNTIME_DIR__|$ESCAPED_RUNTIME_DIR|g" "$PLUGIN_DIR/.mcp.json" > "$PLUGIN_DIR/.mcp.json.installing"
mv "$PLUGIN_DIR/.mcp.json.installing" "$PLUGIN_DIR/.mcp.json"
cp "$SOURCE/marketplace.json" "$REPLAY_INSTALL_ROOT/marketplace.json"

echo "Replay $VERSION installed."
if [ "\${REPLAY_SKIP_CODEX_PLUGIN_INSTALL:-}" = "1" ]; then
  echo "Skipped Codex plugin installation (REPLAY_SKIP_CODEX_PLUGIN_INSTALL=1)."
elif command -v codex >/dev/null 2>&1; then
  codex plugin marketplace add "$REPLAY_INSTALL_ROOT/marketplace.json" || true
  codex plugin add replay-mcp@replay
  echo "Open a new Codex task to use Replay."
else
  echo "Install Codex CLI, then run:"
  echo "  codex plugin marketplace add $REPLAY_INSTALL_ROOT/marketplace.json"
  echo "  codex plugin add replay-mcp@replay"
fi
`;
}
