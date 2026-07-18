import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { recHome } from "./storage.js";

export type IdleMode = "cut" | "fast_forward" | "preserve";

export interface ReplayDefaults {
  idle_mode: IdleMode;
  idle_retained_ms: number;
  idle_fast_forward_speed: number;
  default_speed: number;
}

export interface BrowserConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  executable?: string;
}

export interface ResolvedRecConfig {
  browser: BrowserConfig;
  replay: ReplayDefaults;
  sources: string[];
  warnings: string[];
  fingerprint: string;
}

export interface ResolveConfigOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

type PartialConfig = {
  browser?: Partial<{ headless: boolean; viewport: string; executable: string }>;
  replay?: Partial<{ idle_mode: IdleMode; idle_retained_ms: number; idle_fast_forward_speed: number; default_speed: number }>;
};

const DEFAULT_BROWSER: BrowserConfig = { headless: false, viewport: { width: 1280, height: 720 } };
const DEFAULT_REPLAY: ReplayDefaults = { idle_mode: "cut", idle_retained_ms: 2_000, idle_fast_forward_speed: 8, default_speed: 1.15 };

/** Resolve Rec's small TOML configuration surface without tying it to an MCP client. */
export async function resolveRecConfig(options: ResolveConfigOptions = {}): Promise<ResolvedRecConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? recHome();
  const cwd = resolve(options.cwd ?? env.REC_CONFIG_CWD ?? process.cwd());
  const sources: string[] = [];
  const warnings: string[] = [];
  let merged: PartialConfig = {};
  const candidates = [
    { path: join(home, "config.toml"), required: false },
    { path: join(cwd, ".rec", "config.toml"), required: false },
    ...(env.REC_CONFIG ? [{ path: resolve(env.REC_CONFIG), required: true }] : []),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      if (candidate.required) throw new Error(`Rec config file does not exist: ${candidate.path}`);
      continue;
    }
    const parsed = parseToml(await readFile(candidate.path, "utf8"), candidate.path);
    merged = merge(merged, parsed.value);
    warnings.push(...parsed.warnings);
    sources.push(candidate.path);
  }
  merged = merge(merged, environmentConfig(env));
  const browser = {
    headless: merged.browser?.headless ?? DEFAULT_BROWSER.headless,
    viewport: parseViewport(merged.browser?.viewport ?? "1280x720", sourceFor("browser.viewport", sources)),
    ...(merged.browser?.executable ? { executable: merged.browser.executable } : {}),
  };
  const replay: ReplayDefaults = {
    idle_mode: validateIdleMode(merged.replay?.idle_mode ?? DEFAULT_REPLAY.idle_mode, sourceFor("replay.idle_mode", sources)),
    idle_retained_ms: positive(merged.replay?.idle_retained_ms ?? DEFAULT_REPLAY.idle_retained_ms, "replay.idle_retained_ms", sources),
    idle_fast_forward_speed: positive(merged.replay?.idle_fast_forward_speed ?? DEFAULT_REPLAY.idle_fast_forward_speed, "replay.idle_fast_forward_speed", sources),
    default_speed: positive(merged.replay?.default_speed ?? DEFAULT_REPLAY.default_speed, "replay.default_speed", sources),
  };
  const fingerprint = JSON.stringify({ browser });
  return { browser, replay, sources, warnings, fingerprint };
}

/** Kept public for unit tests and helpful config diagnostics. */
export function parseRecToml(text: string, source = "config.toml") {
  return parseToml(text, source);
}

function parseToml(text: string, source: string): { value: PartialConfig; warnings: string[] } {
  const value: PartialConfig = {};
  const warnings: string[] = [];
  let section = "";
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = removeComment(original).trim();
    if (!line) continue;
    const table = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (table) {
      section = table[1]!;
      if (section !== "browser" && section !== "replay") warnings.push(`${source}:${index + 1}: unknown table [${section}] ignored`);
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`${source}:${index + 1}: expected key = value`);
    if (section !== "browser" && section !== "replay") { warnings.push(`${source}:${index + 1}: unknown key ${assignment[1]} ignored`); continue; }
    const key = assignment[1]!;
    const known = section === "browser" ? ["headless", "viewport", "executable"] : ["idle_mode", "idle_retained_ms", "idle_fast_forward_speed", "default_speed"];
    if (!known.includes(key)) { warnings.push(`${source}:${index + 1}: unknown key ${section}.${key} ignored`); continue; }
    const parsed = valueOf(assignment[2]!, `${source}:${index + 1}`);
    if (section === "browser") {
      const browser = value.browser ?? (value.browser = {});
      if (key === "headless" && typeof parsed !== "boolean") throw new Error(`${source}:${index + 1}: browser.headless must be true or false`);
      if ((key === "viewport" || key === "executable") && typeof parsed !== "string") throw new Error(`${source}:${index + 1}: browser.${key} must be a quoted string`);
      Object.assign(browser, { [key]: parsed });
    } else {
      const replay = value.replay ?? (value.replay = {});
      if (key === "idle_mode" && typeof parsed !== "string") throw new Error(`${source}:${index + 1}: replay.idle_mode must be a quoted string`);
      if (key !== "idle_mode" && typeof parsed !== "number") throw new Error(`${source}:${index + 1}: replay.${key} must be a number`);
      Object.assign(replay, { [key]: parsed });
    }
  }
  return { value, warnings };
}

function environmentConfig(env: NodeJS.ProcessEnv): PartialConfig {
  const browser: PartialConfig["browser"] = {};
  const replay: PartialConfig["replay"] = {};
  if (env.REC_BROWSER_HEADLESS !== undefined) browser.headless = booleanValue(env.REC_BROWSER_HEADLESS, "REC_BROWSER_HEADLESS");
  if (env.REC_BROWSER_VIEWPORT !== undefined) browser.viewport = env.REC_BROWSER_VIEWPORT;
  if (env.REC_BROWSER_EXECUTABLE !== undefined) browser.executable = env.REC_BROWSER_EXECUTABLE;
  if (env.REC_REPLAY_IDLE_MODE !== undefined) replay.idle_mode = validateIdleMode(env.REC_REPLAY_IDLE_MODE, "REC_REPLAY_IDLE_MODE");
  if (env.REC_REPLAY_IDLE_RETAINED_MS !== undefined) replay.idle_retained_ms = numericValue(env.REC_REPLAY_IDLE_RETAINED_MS, "REC_REPLAY_IDLE_RETAINED_MS");
  if (env.REC_REPLAY_IDLE_FAST_FORWARD_SPEED !== undefined) replay.idle_fast_forward_speed = numericValue(env.REC_REPLAY_IDLE_FAST_FORWARD_SPEED, "REC_REPLAY_IDLE_FAST_FORWARD_SPEED");
  if (env.REC_REPLAY_DEFAULT_SPEED !== undefined) replay.default_speed = numericValue(env.REC_REPLAY_DEFAULT_SPEED, "REC_REPLAY_DEFAULT_SPEED");
  return { browser, replay };
}

function merge(left: PartialConfig, right: PartialConfig): PartialConfig {
  return { browser: { ...left.browser, ...right.browser }, replay: { ...left.replay, ...right.replay } };
}
function valueOf(value: string, source: string): string | boolean | number {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\(["\\])/g, "$1");
  throw new Error(`${source}: unsupported TOML value`);
}
function removeComment(value: string) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (value[index] === "#" && !quoted) return value.slice(0, index);
  }
  return value;
}
function parseViewport(value: string, source: string) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error(`${source}: browser.viewport must be WIDTHxHEIGHT`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
function validateIdleMode(value: string, source: string): IdleMode {
  if (value === "cut" || value === "fast_forward" || value === "preserve") return value;
  throw new Error(`${source}: replay.idle_mode must be cut, fast_forward, or preserve`);
}
function positive(value: number, key: string, sources: string[]) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${sourceFor(key, sources)}: ${key} must be a positive number`);
  return value;
}
function numericValue(value: string, key: string) { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${key} must be a finite number`); return number; }
function booleanValue(value: string, key: string) { if (value === "true") return true; if (value === "false") return false; throw new Error(`${key} must be true or false`); }
function sourceFor(key: string, sources: string[]) { return sources.at(-1) ?? key; }
