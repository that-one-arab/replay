import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("bootstrap installs a verified runtime from the release feed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rec-bootstrap-"));
  const version = "0.2.0";
  const platform = "darwin-arm64";
  const releaseRoot = join(root, `rec-${version}-${platform}`);
  const runtime = join(releaseRoot, "runtime");
  const archive = join(root, "runtime.tar.gz");
  const installed = join(root, "installed");
  const server = createServer();
  try {
    await mkdir(join(runtime, "bin"), { recursive: true });
    await writeFile(join(runtime, "bin", "rec-mcp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(runtime, "bin", "rec-playwright-launcher"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await run("tar", ["-C", root, "-czf", archive, `rec-${version}-${platform}`]);
    const artifact = await readFile(archive);
    const checksum = createHash("sha256").update(artifact).digest("hex");
    server.on("request", (request, response) => {
      const origin = `http://${request.headers.host}`;
      if (request.url?.startsWith(`/v1/releases/${version}`)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version, platform, sha256: checksum, archiveUrl: `${origin}/archive` }));
      } else if (request.url === "/archive") {
        response.writeHead(200, { "content-type": "application/gzip" });
        response.end(artifact);
      } else response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the release feed fixture.");
    const bootstrapUrl = new URL("../../../plugins/rec-mcp/scripts/rec-bootstrap.mjs", import.meta.url).href;
    const { ensureRuntime } = await import(bootstrapUrl) as { ensureRuntime: (options: { releaseEndpoint: string; runtimeHome: string; platform: string; version: string }) => Promise<string> };
    const result = await ensureRuntime({ releaseEndpoint: `http://127.0.0.1:${address.port}/v1/releases`, runtimeHome: installed, platform, version });
    assert.equal(result, join(installed, version));
    assert.equal(await readFile(join(result, "bin", "rec-mcp"), "utf8"), "#!/bin/sh\nexit 0\n");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
