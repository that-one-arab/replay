import type { IncomingMessage } from "node:http";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";

// Per-IP, in-memory rate limiting. Two independent budgets: a general one for
// ordinary reads and a stricter one for the write path (POST /v1/recordings),
// which is the expensive, abuse-prone endpoint. Counters live in this process
// only — this server is a single instance, so no shared store is needed.
const generalPoints = Number(process.env.REC_SHARE_RATE_LIMIT_POINTS ?? 120);
const generalDuration = Number(process.env.REC_SHARE_RATE_LIMIT_DURATION ?? 60);
const uploadPoints = Number(process.env.REC_SHARE_UPLOAD_RATE_LIMIT_POINTS ?? 12);
const uploadDuration = Number(process.env.REC_SHARE_UPLOAD_RATE_LIMIT_DURATION ?? 60);
// Only trust X-Forwarded-For when explicitly told to (i.e. the server sits
// behind a reverse proxy we control); otherwise a client could spoof the header
// to dodge the limiter, so we key on the real socket address.
const trustProxy = /^(1|true|yes|on)$/i.test(process.env.REC_SHARE_TRUST_PROXY ?? "");

const general = new RateLimiterMemory({ points: Math.max(generalPoints, 1), duration: generalDuration });
const upload = new RateLimiterMemory({ points: Math.max(uploadPoints, 1), duration: uploadDuration });

export function clientIp(request: IncomingMessage): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// Setting a limit to 0 (or less) disables that budget entirely — useful for
// local runs and tests that fire many requests in a tight loop.
export async function checkRateLimit(kind: "general" | "upload", ip: string): Promise<RateLimitDecision> {
  if ((kind === "upload" ? uploadPoints : generalPoints) <= 0) return { allowed: true };
  try {
    await (kind === "upload" ? upload : general).consume(ip);
    return { allowed: true };
  } catch (result) {
    const retryAfterMs = (result as RateLimiterRes).msBeforeNext ?? 1000;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
}
