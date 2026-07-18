import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = dirname(binDirectory);
const packagesRoot = join(runtimeRoot, "node_modules", "@rec");

export async function run(component) {
  process.env.REC_DAEMON_ENTRY ??= join(packagesRoot, "daemon", "dist", "main.js");
  process.env.REC_PLAYER_DIR ??= join(packagesRoot, "player", "dist");
  await import(pathToFileURL(join(packagesRoot, component, "dist", "main.js")).href);
}
