import pino from "pino";

// Structured JSON logs to stdout. The share server has no logging framework of
// its own; this is the single place output is shaped so an operator reading the
// server's stdout (or a file it is piped to) gets one line per request plus
// lifecycle events. REPLAY_SHARE_LOG_LEVEL tunes verbosity (default "info").
export const logger = pino({ level: process.env.REPLAY_SHARE_LOG_LEVEL ?? "info", base: { service: "replay-share-server" } });

type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
type UploadRejection = "too_large" | "invalid";

// Process-local counters exposed at GET /stats. They reset when the process
// restarts; this is deliberately a lightweight liveness/volume view, not a
// durable metrics store.
const startedAtMs = Date.now();
const startedAtIso = new Date(startedAtMs).toISOString();
const requestsByStatusClass: Record<StatusClass, number> = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
let requestsTotal = 0;
let uploadsAccepted = 0;
let uploadsIdempotent = 0;
let uploadBytes = 0;
let uploadsRejectedTooLarge = 0;
let uploadsRejectedInvalid = 0;
let rateLimited = 0;
let serverErrors = 0;

function statusClass(status: number): StatusClass {
  const bucket = `${Math.floor(status / 100)}xx`;
  return bucket in requestsByStatusClass ? (bucket as StatusClass) : "5xx";
}

export const metrics = {
  recordRequest(status: number) { requestsTotal += 1; requestsByStatusClass[statusClass(status)] += 1; },
  recordUploadAccepted(bytes: number) { uploadsAccepted += 1; uploadBytes += bytes; },
  recordUploadIdempotent(bytes: number) { uploadsIdempotent += 1; uploadBytes += bytes; },
  recordUploadRejected(reason: UploadRejection) { if (reason === "too_large") uploadsRejectedTooLarge += 1; else uploadsRejectedInvalid += 1; },
  recordRateLimited() { rateLimited += 1; },
  recordServerError() { serverErrors += 1; },
  snapshot() {
    return {
      service: "replay-share-server",
      started_at: startedAtIso,
      uptime_seconds: Math.round((Date.now() - startedAtMs) / 1000),
      requests: { total: requestsTotal, by_status_class: { ...requestsByStatusClass } },
      uploads: { accepted: uploadsAccepted, idempotent: uploadsIdempotent, bytes: uploadBytes, rejected_too_large: uploadsRejectedTooLarge, rejected_invalid: uploadsRejectedInvalid },
      rate_limited: rateLimited,
      server_errors: serverErrors,
    };
  },
};
