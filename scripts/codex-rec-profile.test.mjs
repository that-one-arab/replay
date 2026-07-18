import assert from "node:assert/strict";
import test from "node:test";
import { developmentMcpConfig } from "./codex-rec-profile.mjs";

test("development Codex MCP configuration isolates browser and recording state", () => {
  const config = developmentMcpConfig("/workspace/rec", "/Users/example/.rec-dev", 7718);
  for (const name of ["rec", "playwright"]) {
    const server = config.mcpServers[name];
    assert.equal(server.cwd, "/workspace/rec");
    assert.equal(server.env.REC_HOME, "/Users/example/.rec-dev");
    assert.equal(server.env.REC_PORT, "7718");
    assert.equal(server.env.REC_DAEMON_URL, "http://127.0.0.1:7718");
  }
  assert.match(config.mcpServers.rec.args[0], /packages\/mcp\/dist\/main\.js$/);
  assert.match(config.mcpServers.playwright.args[0], /packages\/playwright-launcher\/dist\/main\.js$/);
});
