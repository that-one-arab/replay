#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile as execute } from "node:child_process";

const execFile = promisify(execute);
const releaseEndpoint = process.env.REC_RELEASE_URL ?? "https://stitch-production-2492.up.railway.app/v1/releases";
const runtimeHome = process.env.REC_RUNTIME_HOME ?? join(homedir(), ".rec", "runtimes");
const platform = `${process.platform}-${process.arch}`;
const runtimeVersion = process.env.REC_RUNTIME_VERSION;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const component = process.argv[2];
  if (component !== "rec-mcp" && component !== "rec-playwright-launcher") throw new Error("Rec bootstrap must start rec-mcp or rec-playwright-launcher.");
  void main(component).catch((error) => {
    process.stderr.write(`rec bootstrap: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(component) {
  const runtime = await ensureRuntime();
  const child = spawn(join(runtime, "bin", component), process.argv.slice(3), { stdio: "inherit", env: process.env });
  child.once("error", (error) => { process.stderr.write(`rec bootstrap: could not start ${component}: ${messageOf(error)}\n`); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}

export async function ensureRuntime(options = {}) {
  const configuredEndpoint = options.releaseEndpoint ?? releaseEndpoint;
  const configuredHome = options.runtimeHome ?? runtimeHome;
  const configuredPlatform = options.platform ?? platform;
  if (configuredPlatform !== "darwin-arm64") throw new Error(`No Rec runtime is available for ${configuredPlatform}.`);
  const metadata = await releaseMetadata(configuredEndpoint, configuredPlatform, options.version ?? runtimeVersion);
  const runtime = join(configuredHome, metadata.version);
  if (existsSync(join(runtime, "bin", "rec-mcp"))) return runtime;
  await mkdir(configuredHome, { recursive: true });
  return withInstallLock(join(configuredHome, `.install-${metadata.version}`), async () => {
    if (existsSync(join(runtime, "bin", "rec-mcp"))) return runtime;
    await installRuntime(metadata, runtime, configuredHome);
    return runtime;
  });
}

async function releaseMetadata(endpoint, expectedPlatform, expectedVersion) {
  const url = releaseMetadataUrl(endpoint, expectedVersion);
  url.searchParams.set("platform", expectedPlatform);
  const response = await fetch(url);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Release feed returned ${response.status}.`);
  if (!value || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) || value.platform !== expectedPlatform || typeof value.archiveUrl !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) throw new Error("Release feed returned invalid metadata.");
  if (expectedVersion && value.version !== expectedVersion) throw new Error(`Release feed returned ${value.version}; expected pinned Rec runtime ${expectedVersion}.`);
  return value;
}

function releaseMetadataUrl(endpoint, version) {
  const url = new URL(endpoint);
  const suffix = version ?? "latest";
  // Accept the previous /latest setting during migration, while new plugin
  // releases point at the collection endpoint and request their own version.
  url.pathname = url.pathname.replace(/\/(?:latest|\d+\.\d+\.\d+)$/, "").replace(/\/$/, "") + `/${suffix}`;
  return url;
}

async function installRuntime(metadata, destination, home) {
  const temporary = await mkdtemp(join(tmpdir(), "rec-runtime-"));
  try {
    const archive = join(temporary, "runtime.tar.gz");
    const response = await fetch(metadata.archiveUrl);
    if (!response.ok) throw new Error(`Runtime download returned ${response.status}.`);
    const body = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(body).digest("hex") !== metadata.sha256) throw new Error("Runtime checksum did not match the release feed.");
    await writeFile(archive, body, { mode: 0o600 });
    await execFile("tar", ["-xzf", archive, "-C", temporary]);
    const source = join(temporary, `rec-${metadata.version}-${metadata.platform}`, "runtime");
    if (!existsSync(join(source, "bin", "rec-mcp"))) throw new Error("Runtime archive does not contain Rec's MCP executable.");
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    await chmod(join(destination, "bin", "rec-mcp"), 0o755);
    await chmod(join(destination, "bin", "rec-playwright-launcher"), 0o755);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withInstallLock(path, action) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(path);
      try { return await action(); } finally { await rm(path, { recursive: true, force: true }); }
    } catch (error) {
      if ((error?.code !== "EEXIST") || Date.now() >= deadline) throw new Error("Another Rec runtime install did not finish in time.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

function messageOf(error) { return error instanceof Error ? error.message : String(error); }
