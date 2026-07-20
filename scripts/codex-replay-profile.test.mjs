import assert from "node:assert/strict";
import test from "node:test";
import { installedPlugin } from "./codex-replay-profile.mjs";

test("installedPlugin detects an enabled plugin in `codex plugin list` output", () => {
  const output = [
    "PLUGIN               STATUS              VERSION  PATH",
    "replay-mcp@replay    installed, enabled  0.2.2    /Users/x/.replay/runtimes/0.2.2",
    "wix@openai-curated   not installed               /Users/x/.codex/plugins/wix",
  ].join("\n");
  assert.equal(installedPlugin(output, "replay-mcp@replay"), true);
  assert.equal(installedPlugin(output, "wix@openai-curated"), false);
  assert.equal(installedPlugin(output, "replay-mcp-dev@replay-dev"), false);
});

test("installedPlugin does not match a plugin id that is a prefix of another", () => {
  // The regex anchors the id to the whitespace before STATUS, so a real
  // "replay-mcp@replay" line must not match a hypothetical line for a plugin
  // whose id merely starts with it.
  const output = "replay-mcp@replay-staging    installed, enabled    /path";
  assert.equal(installedPlugin(output, "replay-mcp@replay"), false);
});
