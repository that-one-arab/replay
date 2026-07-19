import assert from "node:assert/strict";
import test from "node:test";
import { developmentMcpConfig } from "./codex-rec-profile.mjs";

test("development Codex MCP configuration isolates browser and recording state", () => {
  const config = developmentMcpConfig("/workspace/rec", "/Users/example/.rec-dev", 7718);
  const server = config.mcpServers.rec;
  assert.equal(server.cwd, "/workspace/rec");
  assert.equal(server.env.REC_HOME, "/Users/example/.rec-dev");
  assert.equal(server.env.REC_PORT, "7718");
  assert.equal(server.env.REC_DAEMON_URL, "http://127.0.0.1:7718");
  assert.equal(server.env.REC_SHARE_URL, "https://stitch-production-2492.up.railway.app");
  assert.match(server.args[0], /packages\/mcp\/dist\/main\.js$/);
  // rec-mcp embeds Playwright MCP; a second entry would duplicate browser tools.
  assert.equal(config.mcpServers.playwright, undefined);
});
