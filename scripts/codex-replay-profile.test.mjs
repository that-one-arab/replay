import assert from "node:assert/strict";
import test from "node:test";
import { developmentMcpConfig } from "./codex-replay-profile.mjs";

test("development Codex MCP configuration isolates browser and replay state", () => {
  const config = developmentMcpConfig("/workspace/replay", "/Users/example/.replay-dev", 7718);
  const server = config.mcpServers.replay;
  assert.equal(server.cwd, "/workspace/replay");
  assert.equal(server.env.REPLAY_HOME, "/Users/example/.replay-dev");
  assert.equal(server.env.REPLAY_PORT, "7718");
  assert.equal(server.env.REPLAY_DAEMON_URL, "http://127.0.0.1:7718");
  assert.equal(server.env.REPLAY_SHARE_URL, "https://stitch-production-2492.up.railway.app");
  assert.match(server.args[0], /packages\/mcp\/dist\/main\.js$/);
  // replay-mcp embeds Playwright MCP; a second entry would duplicate browser tools.
  assert.equal(config.mcpServers.playwright, undefined);
});
