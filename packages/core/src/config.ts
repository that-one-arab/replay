import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { replayHome } from "./storage.js";

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

export type ChatProviderName = "auto" | "codex" | "openai";

export interface ChatConfig {
  enabled: boolean;
  /**
   * Which backend answers the chat. "auto" (default) prefers the OpenAI API
   * when a key is available and falls back to the Codex CLI otherwise.
   */
  provider: ChatProviderName;
  /** Executable used when the Codex CLI is the provider. */
  command: string;
  /** Optional model override (Codex `-m`, or the OpenAI Responses model). */
  model?: string;
  /** OpenAI API key; OPENAI_API_KEY and REPLAY_CHAT_API_KEY also work. */
  api_key?: string;
}

export interface ReviewConfig {
  /** When true, capture_stop refuses outcome=reproduced without a resolved defect highlight. */
  strict: boolean;
}

export interface ResolvedReplayConfig {
  browser: BrowserConfig;
  replay: ReplayDefaults;
  chat: ChatConfig;
  review: ReviewConfig;
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
  chat?: Partial<{ enabled: boolean; provider: string; command: string; model: string; api_key: string }>;
  review?: Partial<{ strict: boolean }>;
};

const DEFAULT_BROWSER: BrowserConfig = { headless: false, viewport: { width: 1280, height: 720 } };
const DEFAULT_REPLAY: ReplayDefaults = { idle_mode: "cut", idle_retained_ms: 2_000, idle_fast_forward_speed: 8, default_speed: 1.15 };
const DEFAULT_CHAT: ChatConfig = { enabled: true, provider: "auto", command: "codex" };
const DEFAULT_REVIEW: ReviewConfig = { strict: false };

/** Resolve Replay's small TOML configuration surface without tying it to an MCP client. */
export async function resolveReplayConfig(options: ResolveConfigOptions = {}): Promise<ResolvedReplayConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? replayHome();
  const cwd = resolve(options.cwd ?? env.REPLAY_CONFIG_CWD ?? process.cwd());
  const sources: string[] = [];
  const warnings: string[] = [];
  let merged: PartialConfig = {};
  const candidates = [
    { path: join(home, "config.toml"), required: false },
    { path: join(cwd, ".replay", "config.toml"), required: false },
    ...(env.REPLAY_CONFIG ? [{ path: resolve(env.REPLAY_CONFIG), required: true }] : []),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      if (candidate.required) throw new Error(`Replay config file does not exist: ${candidate.path}`);
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
  const chat: ChatConfig = {
    enabled: merged.chat?.enabled ?? DEFAULT_CHAT.enabled,
    provider: validateChatProvider(merged.chat?.provider ?? DEFAULT_CHAT.provider, sourceFor("chat.provider", sources)),
    command: merged.chat?.command || DEFAULT_CHAT.command,
    ...(merged.chat?.model ? { model: merged.chat.model } : {}),
    ...(merged.chat?.api_key ? { api_key: merged.chat.api_key } : {}),
  };
  const review: ReviewConfig = {
    strict: merged.review?.strict ?? DEFAULT_REVIEW.strict,
  };
  const fingerprint = JSON.stringify({ browser });
  return { browser, replay, chat, review, sources, warnings, fingerprint };
}

/** Kept public for unit tests and helpful config diagnostics. */
export function parseReplayToml(text: string, source = "config.toml") {
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
      if (section !== "browser" && section !== "replay" && section !== "chat" && section !== "review") warnings.push(`${source}:${index + 1}: unknown table [${section}] ignored`);
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`${source}:${index + 1}: expected key = value`);
    if (section !== "browser" && section !== "replay" && section !== "chat" && section !== "review") { warnings.push(`${source}:${index + 1}: unknown key ${assignment[1]} ignored`); continue; }
    const key = assignment[1]!;
    const known = section === "browser"
      ? ["headless", "viewport", "executable"]
      : section === "replay"
        ? ["idle_mode", "idle_retained_ms", "idle_fast_forward_speed", "default_speed"]
        : section === "review"
          ? ["strict"]
          : ["enabled", "provider", "command", "model", "api_key"];
    if (!known.includes(key)) { warnings.push(`${source}:${index + 1}: unknown key ${section}.${key} ignored`); continue; }
    const parsed = valueOf(assignment[2]!, `${source}:${index + 1}`);
    if (section === "browser") {
      const browser = value.browser ?? (value.browser = {});
      if (key === "headless" && typeof parsed !== "boolean") throw new Error(`${source}:${index + 1}: browser.headless must be true or false`);
      if ((key === "viewport" || key === "executable") && typeof parsed !== "string") throw new Error(`${source}:${index + 1}: browser.${key} must be a quoted string`);
      Object.assign(browser, { [key]: parsed });
    } else if (section === "replay") {
      const replay = value.replay ?? (value.replay = {});
      if (key === "idle_mode" && typeof parsed !== "string") throw new Error(`${source}:${index + 1}: replay.idle_mode must be a quoted string`);
      if (key !== "idle_mode" && typeof parsed !== "number") throw new Error(`${source}:${index + 1}: replay.${key} must be a number`);
      Object.assign(replay, { [key]: parsed });
    } else if (section === "review") {
      const review = value.review ?? (value.review = {});
      if (key === "strict" && typeof parsed !== "boolean") throw new Error(`${source}:${index + 1}: review.strict must be true or false`);
      Object.assign(review, { [key]: parsed });
    } else {
      const chat = value.chat ?? (value.chat = {});
      if (key === "enabled" && typeof parsed !== "boolean") throw new Error(`${source}:${index + 1}: chat.enabled must be true or false`);
      if (key !== "enabled" && typeof parsed !== "string") throw new Error(`${source}:${index + 1}: chat.${key} must be a quoted string`);
      Object.assign(chat, { [key]: parsed });
    }
  }
  return { value, warnings };
}

function environmentConfig(env: NodeJS.ProcessEnv): PartialConfig {
  const browser: PartialConfig["browser"] = {};
  const replay: PartialConfig["replay"] = {};
  const chat: PartialConfig["chat"] = {};
  const review: PartialConfig["review"] = {};
  if (env.REPLAY_CHAT_ENABLED !== undefined) chat.enabled = booleanValue(env.REPLAY_CHAT_ENABLED, "REPLAY_CHAT_ENABLED");
  if (env.REPLAY_CHAT_PROVIDER !== undefined) chat.provider = env.REPLAY_CHAT_PROVIDER;
  if (env.REPLAY_CHAT_COMMAND !== undefined) chat.command = env.REPLAY_CHAT_COMMAND;
  if (env.REPLAY_CHAT_MODEL !== undefined) chat.model = env.REPLAY_CHAT_MODEL;
  if (env.REPLAY_CHAT_API_KEY !== undefined) chat.api_key = env.REPLAY_CHAT_API_KEY;
  if (env.REPLAY_BROWSER_HEADLESS !== undefined) browser.headless = booleanValue(env.REPLAY_BROWSER_HEADLESS, "REPLAY_BROWSER_HEADLESS");
  if (env.REPLAY_BROWSER_VIEWPORT !== undefined) browser.viewport = env.REPLAY_BROWSER_VIEWPORT;
  if (env.REPLAY_BROWSER_EXECUTABLE !== undefined) browser.executable = env.REPLAY_BROWSER_EXECUTABLE;
  if (env.REPLAY_IDLE_MODE !== undefined) replay.idle_mode = validateIdleMode(env.REPLAY_IDLE_MODE, "REPLAY_IDLE_MODE");
  if (env.REPLAY_IDLE_RETAINED_MS !== undefined) replay.idle_retained_ms = numericValue(env.REPLAY_IDLE_RETAINED_MS, "REPLAY_IDLE_RETAINED_MS");
  if (env.REPLAY_IDLE_FAST_FORWARD_SPEED !== undefined) replay.idle_fast_forward_speed = numericValue(env.REPLAY_IDLE_FAST_FORWARD_SPEED, "REPLAY_IDLE_FAST_FORWARD_SPEED");
  if (env.REPLAY_DEFAULT_SPEED !== undefined) replay.default_speed = numericValue(env.REPLAY_DEFAULT_SPEED, "REPLAY_DEFAULT_SPEED");
  if (env.REPLAY_REVIEW_STRICT !== undefined) review.strict = booleanValue(env.REPLAY_REVIEW_STRICT, "REPLAY_REVIEW_STRICT");
  return { browser, replay, chat, review };
}

function merge(left: PartialConfig, right: PartialConfig): PartialConfig {
  return { browser: { ...left.browser, ...right.browser }, replay: { ...left.replay, ...right.replay }, chat: { ...left.chat, ...right.chat }, review: { ...left.review, ...right.review } };
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
function validateChatProvider(value: string, source: string): ChatProviderName {
  if (value === "auto" || value === "codex" || value === "openai") return value;
  throw new Error(`${source}: chat.provider must be auto, codex, or openai`);
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
