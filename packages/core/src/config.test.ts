import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRecToml, resolveRecConfig } from "./config.js";

test("resolves user, project, explicit, and environment configuration by precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rec-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const explicit = join(root, "explicit.toml");
  try {
    await mkdir(join(home), { recursive: true });
    await mkdir(join(project, ".rec"), { recursive: true });
    await writeFile(join(home, "config.toml"), "[browser]\nheadless = true\n[replay]\nidle_mode = \"preserve\"\ndefault_speed = 1.4\n");
    await writeFile(join(project, ".rec", "config.toml"), "[browser]\nviewport = \"1440x900\"\n[replay]\nidle_mode = \"fast_forward\"\nidle_fast_forward_speed = 6\n");
    await writeFile(explicit, "[replay]\nidle_retained_ms = 1500\n");
    const config = await resolveRecConfig({ home, cwd: project, env: { REC_CONFIG: explicit, REC_REPLAY_DEFAULT_SPEED: "1.6" } });
    assert.deepEqual(config.browser, { headless: true, viewport: { width: 1440, height: 900 } });
    assert.deepEqual(config.replay, { idle_mode: "fast_forward", idle_retained_ms: 1500, idle_fast_forward_speed: 6, default_speed: 1.6 });
    assert.equal(config.sources.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports unknown keys and rejects invalid configuration values", async () => {
  const parsed = parseRecToml("[replay]\nunknown = 1\nidle_mode = \"cut\"\n", "fixture.toml");
  assert.match(parsed.warnings[0]!, /unknown key replay\.unknown/);
  assert.throws(() => parseRecToml("[browser]\nheadless = \"yes\"\n", "fixture.toml"), /headless must be true or false/);
});
