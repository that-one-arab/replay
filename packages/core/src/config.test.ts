import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseReplayToml, resolveReplayConfig } from "./config.js";

test("resolves user, project, explicit, and environment configuration by precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const explicit = join(root, "explicit.toml");
  try {
    await mkdir(join(home), { recursive: true });
    await mkdir(join(project, ".replay"), { recursive: true });
    await writeFile(join(home, "config.toml"), "[browser]\nheadless = true\n[replay]\nidle_mode = \"preserve\"\ndefault_speed = 1.4\n");
    await writeFile(join(project, ".replay", "config.toml"), "[browser]\nviewport = \"1440x900\"\n[replay]\nidle_mode = \"fast_forward\"\nidle_fast_forward_speed = 6\n");
    await writeFile(explicit, "[replay]\nidle_retained_ms = 1500\n");
    const config = await resolveReplayConfig({ home, cwd: project, env: { REPLAY_CONFIG: explicit, REPLAY_DEFAULT_SPEED: "1.6" } });
    assert.deepEqual(config.browser, { headless: true, viewport: { width: 1440, height: 900 } });
    assert.deepEqual(config.replay, { idle_mode: "fast_forward", idle_retained_ms: 1500, idle_fast_forward_speed: 6, default_speed: 1.6 });
    assert.equal(config.sources.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports unknown keys and rejects invalid configuration values", async () => {
  const parsed = parseReplayToml("[replay]\nunknown = 1\nidle_mode = \"cut\"\n", "fixture.toml");
  assert.match(parsed.warnings[0]!, /unknown key replay\.unknown/);
  assert.throws(() => parseReplayToml("[browser]\nheadless = \"yes\"\n", "fixture.toml"), /headless must be true or false/);
});

test("review.strict defaults off and parses from TOML, env, and rejects non-booleans", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-config-review-"));
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    const defaulted = await resolveReplayConfig({ home, env: {} });
    assert.equal(defaulted.review.strict, false);
    await writeFile(join(home, "config.toml"), "[review]\nstrict = true\n");
    const fromToml = await resolveReplayConfig({ home, env: {} });
    assert.equal(fromToml.review.strict, true);
    const fromEnv = await resolveReplayConfig({ home: join(root, "empty"), cwd: join(root, "empty"), env: { REPLAY_REVIEW_STRICT: "true" } });
    assert.equal(fromEnv.review.strict, true);
    assert.throws(() => parseReplayToml("[review]\nstrict = \"yes\"\n", "fixture.toml"), /review\.strict must be true or false/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
