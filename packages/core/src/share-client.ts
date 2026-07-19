import { readFile } from "node:fs/promises";

export type ShareUploadResult = { shareUrl: string; sessionId?: string; shareId?: string; summaryUrl?: string };

export type ShareUploadOptions = {
  timeoutMs?: number;
  attempts?: number;
  // Injection seams so the retry/backoff behavior is testable without real
  // sockets or real waits.
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

// Uploads are large and cross the public internet; give a slow-but-alive
// connection generous headroom before treating it as dead.
const DEFAULT_TIMEOUT_MS = 120_000;
// The share server imports idempotently, so a retried upload is safe: a network
// blip or a transient 5xx during import hands back the same link next time.
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// Upload a portable `.replay` artifact to the remote share server. Turns the raw,
// cryptic failures of a bare fetch — connection refused, DNS failure, a hung
// server — into clear, actionable errors that name the endpoint, and retries
// transient failures with backoff before giving up.
export async function uploadReplay(shareEndpoint: string, artifactPath: string, options: ShareUploadOptions = {}): Promise<ShareUploadResult> {
  const endpoint = shareEndpoint.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? envTimeout() ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const call = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const body = await readFile(artifactPath);
  const target = `${endpoint}/v1/replays`;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await call(target, { method: "POST", headers: { "content-type": "application/vnd.replay" }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = unreachable(endpoint, timeoutMs, error);
      if (attempt < attempts) { await wait(backoff(attempt)); continue; }
      throw lastError;
    }
    const result = asRecord(await response.json().catch(() => ({})));
    if (response.ok) {
      const shareUrl = text(result.shareUrl);
      if (!shareUrl) throw new Error(`The share server at ${endpoint} accepted the replay but returned no share link.`);
      return { shareUrl, sessionId: text(result.sessionId), shareId: text(result.shareId), summaryUrl: text(result.summaryUrl) };
    }
    const detail = text(result.error) ?? response.statusText ?? `HTTP ${response.status}`;
    if (retriable(response.status) && attempt < attempts) {
      lastError = new Error(`The share server at ${endpoint} is unavailable (${response.status}: ${detail}).`);
      await wait(backoff(attempt));
      continue;
    }
    throw new Error(`The share server at ${endpoint} rejected the replay (${response.status}: ${detail}).`);
  }
  throw lastError ?? new Error(`Could not share the replay via ${endpoint}.`);
}

function envTimeout() { const raw = Number(process.env.REPLAY_SHARE_TIMEOUT_MS); return Number.isFinite(raw) && raw > 0 ? raw : undefined; }
function backoff(attempt: number) { return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)); }
// Retry only what a later attempt could plausibly fix: the timeout/rate-limit
// codes and 5xx. A 4xx (400 malformed, 409 duplicate, 413 too large) is the
// client's fault and would fail identically on every retry.
function retriable(status: number) { return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599); }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" && value ? value : undefined; }

function unreachable(endpoint: string, timeoutMs: number, error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return new Error(`The share server at ${endpoint} did not respond within ${Math.round(timeoutMs / 1000)}s.`, { cause: error });
  if (name === "AbortError") return new Error(`The upload to the share server at ${endpoint} was interrupted.`, { cause: error });
  const cause = (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });
  const reason = describeCode(cause?.code) ?? (error instanceof Error ? error.message : String(error));
  return new Error(`Could not reach the share server at ${endpoint}: ${reason}. Check REPLAY_SHARE_URL and that the server is running.`, { cause: error });
}

function describeCode(code: string | undefined) {
  switch (code) {
    case "ECONNREFUSED": return "the connection was refused";
    case "ENOTFOUND": case "EAI_AGAIN": return "the host could not be resolved";
    case "ETIMEDOUT": return "the connection timed out";
    case "ECONNRESET": return "the connection was reset";
    case "EHOSTUNREACH": case "ENETUNREACH": return "the host was unreachable";
    default: return code;
  }
}
