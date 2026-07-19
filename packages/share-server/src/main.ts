import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { exportPath, exportSession, formatTime, importSession, renderSummaryText, sessionPath, stepsInRange, summarizeReplay, type AgentAction, type ReplayManifest, type ReplaySummary } from "../../core/dist/index.js";
import { checkRateLimit, clientIp } from "./rate-limit.js";
import { logger, metrics } from "./telemetry.js";

const port = Number(process.env.PORT ?? 8080);
const dataDir = resolve(process.env.REPLAY_SHARE_DATA_DIR ?? "./.replay-share");
// The core importer intentionally uses REPLAY_HOME. This process owns that spool
// exclusively, separate from the local capture's home.
process.env.REPLAY_HOME = join(dataDir, "spool");
const uploadsDir = join(dataDir, "uploads");
const sharesPath = join(dataDir, "shares.json");
const maxUploadBytes = Number(process.env.REPLAY_SHARE_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);
const releasesDir = resolve(process.env.REPLAY_RELEASE_DIR ?? join(dataDir, "releases"));
const releasesPath = join(releasesDir, "index.json");
const maxReleaseBytes = Number(process.env.REPLAY_RELEASE_MAX_UPLOAD_BYTES ?? 150 * 1024 * 1024);
const releasePublishToken = process.env.REPLAY_RELEASE_PUBLISH_TOKEN;
// GET /stats stays disabled unless a token is configured, so the counters are
// never exposed on a public server by default.
const statsToken = process.env.REPLAY_SHARE_STATS_TOKEN;

type Share = { id: string; session_id: string; title: string; created_at: string; bytes: number; revoked?: boolean };
type Release = { version: string; platform: "darwin-arm64"; archive: string; sha256: string; bytes: number; published_at: string };

// A client fault (oversize body, malformed headers, an artifact that will not
// import) is reported with its own status; anything unclassified is a genuine
// 500 the operator needs to see.
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const server = createServer((request, response) => {
  const startedAt = process.hrtime.bigint();
  // One access-log line per response. Listening on "finish" (rather than logging
  // inside route) captures the final status for every path, including streamed
  // file bodies and errors the catch below maps to a status.
  response.on("finish", () => {
    metrics.recordRequest(response.statusCode);
    logger.info({ method: request.method, path: (request.url ?? "/").split("?")[0], status: response.statusCode, duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10, ip: clientIp(request) }, "request");
  });
  void handle(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    // A non-HttpError is an unclassified server fault; surface it in the logs and
    // count it, since the JSON reply only carries the message.
    if (status >= 500) { metrics.recordServerError(); logger.error({ path: (request.url ?? "/").split("?")[0], err: messageOf(error) }, "unhandled request error"); }
    if (!response.headersSent) reply(response, status, { error: messageOf(error) });
  });
});
server.listen(port, "0.0.0.0", () => logger.info({ port, data_dir: dataDir }, "replay share server listening"));

// Gate every request behind the per-IP rate limiter before routing. Health is
// exempt so uptime probes never consume a client's budget.
async function handle(request: IncomingMessage, response: ServerResponse) {
  const origin = requestOrigin(request);
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname !== "/health") {
    const kind = request.method === "POST" && url.pathname === "/v1/replays" ? "upload" : "general";
    const decision = await checkRateLimit(kind, clientIp(request));
    if (!decision.allowed) {
      metrics.recordRateLimited();
      response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": String(decision.retryAfterSeconds) });
      return void response.end(JSON.stringify({ error: "Too many requests. Retry after a moment." }));
    }
  }
  return route(request, response, url, origin);
}

async function route(request: IncomingMessage, response: ServerResponse, url: URL, origin: string) {
  if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
  if (request.method === "GET" && url.pathname === "/stats") return serveStats(request, response);
  if (request.method === "POST" && url.pathname === "/v1/replays") return upload(request, response, origin);
  if (request.method === "PUT" && url.pathname === "/v1/releases") return publishRelease(request, response);
  if (request.method === "GET" && url.pathname === "/v1/releases/latest") return latestRelease(response, origin, url.searchParams.get("platform"));
  const releaseMetadata = /^\/v1\/releases\/(\d+\.\d+\.\d+)$/.exec(url.pathname);
  if (request.method === "GET" && releaseMetadata) return releaseByVersion(response, origin, releaseMetadata[1]!, url.searchParams.get("platform"));
  const releaseArchive = /^\/v1\/releases\/(replay-[0-9]+\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.gz)$/.exec(url.pathname);
  if (request.method === "GET" && releaseArchive) return serveRelease(response, releaseArchive[1]);
  const shared = /^\/r\/([a-f0-9]{24})(?:\.(md|json))?$/.exec(url.pathname);
  if (request.method === "GET" && shared) return serveShare(request, response, shared[1]!, shared[2], origin);
  const shareQuery = /^\/v1\/replays\/([a-f0-9]{24})\/(summary|steps|actions|markers|bundle)$/.exec(url.pathname);
  if (request.method === "GET" && shareQuery) return serveShareQuery(response, shareQuery[1]!, shareQuery[2]!, url.searchParams);
  const replay = /^\/api\/sessions\/([^/]+)\/(manifest|events)$/.exec(url.pathname);
  if (request.method === "GET" && replay) return serveReplay(response, decodeURIComponent(replay[1]), replay[2], url.searchParams.get("segment"));
  const asset = /^\/api\/sessions\/([^/]+)\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
  if (request.method === "GET" && asset) return serveCapturedAsset(response, decodeURIComponent(asset[1]), asset[2]);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return servePlayerAsset(response, url.pathname);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/replay")) return servePlayer(response);
  reply(response, 404, { error: "Not found" });
}

async function publishRelease(request: IncomingMessage, response: ServerResponse) {
  if (!releasePublishToken || !validPublishToken(request.headers.authorization)) return reply(response, 403, { error: "Release publishing is not authorized." });
  const version = releaseVersion(request.headers["x-replay-release-version"]);
  const platform = releasePlatform(request.headers["x-replay-release-platform"]);
  const body = await binaryBody(request, maxReleaseBytes, "Release");
  const archive = `replay-${version}-${platform}.tar.gz`;
  const existing = await readReleases();
  if (existing.some((entry) => entry.version === version && entry.platform === platform)) return reply(response, 409, { error: `Replay ${version} for ${platform} is already published and cannot be replaced.` });
  await mkdir(releasesDir, { recursive: true });
  await writeFile(join(releasesDir, archive), body);
  const release: Release = { version, platform, archive, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.byteLength, published_at: new Date().toISOString() };
  existing.push(release);
  await writeReleases(existing);
  reply(response, 201, release);
}

async function latestRelease(response: ServerResponse, origin: string, platform: string | null) {
  if (platform !== "darwin-arm64") return reply(response, 400, { error: "platform=darwin-arm64 is required." });
  const release = (await readReleases()).filter((entry) => entry.platform === platform).sort((left, right) => compareVersions(right.version, left.version))[0];
  if (!release) return reply(response, 404, { error: "No runtime release is available for this platform." });
  reply(response, 200, releaseMetadata(origin, release));
}

async function releaseByVersion(response: ServerResponse, origin: string, version: string, platform: string | null) {
  if (platform !== "darwin-arm64") return reply(response, 400, { error: "platform=darwin-arm64 is required." });
  const release = (await readReleases()).find((entry) => entry.platform === platform && entry.version === version);
  if (!release) return reply(response, 404, { error: `Replay ${version} for ${platform} is not available.` });
  reply(response, 200, releaseMetadata(origin, release));
}

async function serveRelease(response: ServerResponse, archive: string) {
  const release = (await readReleases()).find((entry) => entry.archive === archive);
  const path = join(releasesDir, archive);
  if (!release || !existsSync(path)) return reply(response, 404, { error: "Runtime release not found." });
  response.writeHead(200, { "content-type": "application/gzip", "content-length": release.bytes, "cache-control": "public, max-age=31536000, immutable" });
  createReadStream(path).pipe(response);
}

async function upload(request: IncomingMessage, response: ServerResponse, origin: string) {
  const body = await binaryBody(request, maxUploadBytes, "Replay").catch((error: unknown) => { if (error instanceof HttpError && error.status === 413) metrics.recordUploadRejected("too_large"); throw error; });
  await mkdir(uploadsDir, { recursive: true });
  const temporary = join(uploadsDir, `${randomBytes(12).toString("hex")}.replay`);
  await writeFile(temporary, body, { flag: "wx" });
  try {
    // Re-sharing an already-uploaded replay is idempotent: keep the installed
    // copy and hand back its existing link instead of failing on a duplicate import.
    // The body is client-supplied, so a failed import is a bad upload (422), not
    // a server fault.
    const imported = await importSession(temporary, { reuseExisting: true }).catch((error: unknown) => { metrics.recordUploadRejected("invalid"); throw new HttpError(422, `The uploaded artifact is not a valid replay: ${messageOf(error)}`); });
    const shares = await readShares();
    // A revoked share stays dead: re-uploading the same replay mints a fresh
    // link instead of resurrecting the revoked one.
    const existing = shares.find((entry) => entry.session_id === imported.sessionId && !entry.revoked);
    if (existing) { metrics.recordUploadIdempotent(body.byteLength); return reply(response, 201, shareHandoff(origin, existing)); }
    const manifest = await readManifest(imported.sessionId);
    const share: Share = { id: randomBytes(12).toString("hex"), session_id: imported.sessionId, title: manifest.title, created_at: new Date().toISOString(), bytes: body.byteLength };
    shares.push(share);
    await writeShares(shares);
    metrics.recordUploadAccepted(body.byteLength);
    return reply(response, 201, shareHandoff(origin, share));
  } finally {
    await rm(temporary, { force: true });
  }
}

// One share URL serves three audiences: a browser gets the 302 to the hosted
// player, a coding agent gets a prompt-ready markdown summary (explicit `.md`
// or an Accept preference for text/markdown), and tooling gets the structured
// summary as `.json`. The negotiated response varies on Accept.
async function serveShare(request: IncomingMessage, response: ServerResponse, shareId: string, format: string | undefined, origin: string) {
  const share = await findShare(shareId);
  if (!share) return reply(response, 404, { error: "Replay share not found" });
  const wantsMarkdown = format === "md" || (!format && /\btext\/markdown\b/.test(request.headers.accept ?? ""));
  if (!format && !wantsMarkdown) {
    response.writeHead(302, { location: `/replay?id=${encodeURIComponent(share.session_id)}`, "cache-control": "no-store", vary: "accept" });
    return void response.end();
  }
  const { summary, actions } = await shareSummary(share);
  if (format === "json") return reply(response, 200, summary);
  response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", vary: "accept" });
  response.end(renderShareMarkdown(share, summary, actions, origin));
}

// The scoped query API for coding agents. Everything is keyed by share id;
// the underlying session is never addressed directly. Steps take either an
// explicit [from_ms, to_ms] window or a marker label that centers one.
async function serveShareQuery(response: ServerResponse, shareId: string, resource: string, params: URLSearchParams) {
  const share = await findShare(shareId);
  if (!share) return reply(response, 404, { error: "Replay share not found" });
  if (resource === "bundle") return serveBundle(response, share);
  if (resource === "actions" || resource === "markers") {
    const manifest = await readManifest(share.session_id);
    return reply(response, 200, resource === "actions" ? manifest.actions ?? [] : manifest.markers);
  }
  const { summary } = await shareSummary(share);
  if (resource === "summary") return reply(response, 200, summary);
  const marker = params.get("marker");
  let from = numberParam(params, "from_ms") ?? 0;
  let to = numberParam(params, "to_ms") ?? summary.duration_ms;
  if (marker) {
    const anchor = summary.steps.find((step) => step.kind === "marker" && step.description.toLowerCase().includes(marker.toLowerCase()));
    if (!anchor) throw new HttpError(404, `No marker matching "${marker}" in this replay.`);
    const window = numberParam(params, "window_ms") ?? 10_000;
    from = Math.max(0, anchor.t_ms - window);
    to = anchor.t_ms + window;
  }
  reply(response, 200, { from_ms: from, to_ms: to, steps: stepsInRange(summary, from, to) });
}

async function serveBundle(response: ServerResponse, share: Share) {
  // The uploaded artifact is deleted after import, so the bundle is re-exported
  // on demand into the spool's exports directory and reused afterwards
  // (exportSession writes exclusively and would fail on a second export).
  const path = existsSync(exportPath(share.session_id)) ? exportPath(share.session_id) : (await exportSession(share.session_id)).path;
  const { size } = await stat(path);
  // no-store keeps revocation meaningful: a cached copy on a shared proxy
  // would outlive the share row.
  response.writeHead(200, { "content-type": "application/vnd.replay", "content-length": size, "content-disposition": `attachment; filename="replay-${share.id}.replay"`, "cache-control": "no-store" });
  createReadStream(path).pipe(response);
}

// Replays are immutable once imported, so a computed summary never goes stale.
// The cache is bounded; Map iteration order makes the first key the oldest.
const summaryCache = new Map<string, { summary: ReplaySummary; actions: AgentAction[] }>();
const SUMMARY_CACHE_MAX = 64;

async function shareSummary(share: Share) {
  const cached = summaryCache.get(share.id);
  if (cached) return cached;
  const manifest = await readManifest(share.session_id);
  const events = new Map<string, unknown[]>();
  for (const segment of manifest.segments) events.set(segment.id, await readChunkEvents(share.session_id, segment.chunks));
  // The summary travels to third parties; it identifies the replay by its
  // share id, not the spool session id.
  const summary: ReplaySummary = { ...summarizeReplay(manifest, events), id: share.id };
  const entry = { summary, actions: manifest.actions ?? [] };
  summaryCache.set(share.id, entry);
  if (summaryCache.size > SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value!);
  return entry;
}

function renderShareMarkdown(share: Share, summary: ReplaySummary, actions: AgentAction[], origin: string) {
  const lines = [renderSummaryText(summary)];
  if (actions.length) {
    const failed = actions.filter((action) => !action.ok).length;
    lines.push("", `Agent browser actions (${actions.length}${failed ? `, ${failed} FAILED` : ""}):`);
    for (const action of actions) lines.push(`- [${formatTime(action.started_at_ms)}] ${action.tool}${action.args_summary ? ` ${action.args_summary}` : ""}${action.ok ? "" : " — FAILED"}`);
  }
  lines.push(
    "",
    "---",
    "This is the agent-readable summary of a Replay browser-session recording.",
    `Watch it in a browser: ${origin}/r/${share.id}`,
    `Structured JSON: ${origin}/r/${share.id}.json`,
    "Network requests and console logs are not part of a replay; the timeline above is the complete captured record.",
  );
  return lines.join("\n") + "\n";
}

async function serveReplay(response: ServerResponse, id: string, resource: string, selected: string | null) {
  if (!(await sessionShared(id))) return reply(response, 404, { error: "Replay not found" });
  const manifest = await readManifest(id);
  if (resource === "manifest") return reply(response, 200, manifest);
  const segments = selected ? manifest.segments.filter((segment) => segment.id === selected) : manifest.segments;
  const events: unknown[] = [];
  for (const segment of segments) events.push(...await readChunkEvents(id, segment.chunks));
  reply(response, 200, events);
}

async function readChunkEvents(sessionId: string, chunks: string[]) {
  const events: unknown[] = [];
  for (const chunk of chunks) {
    const text = gunzipSync(await readFile(join(sessionPath(sessionId), chunk))).toString("utf8");
    for (const line of text.trim().split("\n")) if (line) events.push(JSON.parse(line).event);
  }
  return events;
}

async function serveCapturedAsset(response: ServerResponse, id: string, assetId: string) {
  if (!(await sessionShared(id))) return reply(response, 404, { error: "Replay not found" });
  const manifest = await readManifest(id);
  const asset = manifest.assets.find((entry) => entry.id === assetId);
  if (!asset) return reply(response, 404, { error: "Captured asset not found" });
  const root = sessionPath(id);
  const path = resolve(root, asset.path);
  if (!path.startsWith(`${resolve(root, "assets")}/`) || !existsSync(path)) return reply(response, 404, { error: "Captured asset file not found" });
  response.writeHead(200, { "content-type": asset.content_type, "cache-control": "public, max-age=31536000, immutable" });
  createReadStream(path).pipe(response);
}

function servePlayer(response: ServerResponse) {
  const path = resolve(process.cwd(), "packages/player/dist/index.html");
  if (!existsSync(path)) return reply(response, 503, { error: "Player not built." });
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(path).pipe(response);
}

function servePlayerAsset(response: ServerResponse, pathname: string) {
  const root = resolve(process.cwd(), "packages/player/dist");
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root) || !existsSync(path)) return reply(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : "text/css", "cache-control": "public, max-age=31536000, immutable" });
  createReadStream(path).pipe(response);
}

async function readManifest(id: string) {
  try { return JSON.parse(await readFile(join(sessionPath(id), "manifest.json"), "utf8")) as ReplayManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "Replay not found"); throw error; }
}
// summaryUrl points agents at the machine-readable form of the same link, so a
// sharer can hand one URL to humans and another to a coding agent.
function shareHandoff(origin: string, share: Share) { return { shareId: share.id, sessionId: share.session_id, shareUrl: `${origin}/r/${share.id}`, summaryUrl: `${origin}/r/${share.id}.md` }; }
// A revoked share does not exist anywhere: not on /r/, not on the query API,
// and (via sessionShared) not on the player's session data routes either.
async function findShare(shareId: string) {
  const share = (await readShares()).find((entry) => entry.id === shareId);
  return share && !share.revoked ? share : undefined;
}
// Every session in this spool arrived through an upload, so serving its data
// requires at least one live share that still points at it.
async function sessionShared(sessionId: string) { return (await readShares()).some((entry) => entry.session_id === sessionId && !entry.revoked); }
function numberParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new HttpError(400, `${name} must be a non-negative number of milliseconds.`);
  return value;
}
async function readShares() { try { return JSON.parse(await readFile(sharesPath, "utf8")) as Share[]; } catch { return []; } }
async function readReleases() { try { return JSON.parse(await readFile(releasesPath, "utf8")) as Release[]; } catch { return []; } }
async function writeShares(shares: Share[]) {
  await mkdir(dirname(sharesPath), { recursive: true });
  const temporary = `${sharesPath}.tmp`;
  await writeFile(temporary, JSON.stringify(shares, null, 2) + "\n");
  await rename(temporary, sharesPath);
}
async function writeReleases(releases: Release[]) {
  await mkdir(releasesDir, { recursive: true });
  const temporary = `${releasesPath}.tmp`;
  await writeFile(temporary, JSON.stringify(releases, null, 2) + "\n");
  await rename(temporary, releasesPath);
}
function binaryBody(request: IncomingMessage, maxBytes: number, label: string): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    // Once the limit is passed, stop buffering (so memory stays bounded) but keep
    // draining the socket to end, then reject with a 413. Destroying the request
    // mid-upload instead would tear down the socket and the client would see a
    // dropped connection rather than the status.
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > maxBytes) { overflowed = true; chunks.length = 0; return; } chunks.push(chunk); });
    request.on("end", () => overflowed ? reject(new HttpError(413, `${label} exceeds the ${maxBytes} byte upload limit.`)) : resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
function serveStats(request: IncomingMessage, response: ServerResponse) {
  // Absent a token the endpoint does not exist, so it is never discoverable on a
  // public deployment; with one, a mismatch is an ordinary 401.
  if (!statsToken) return reply(response, 404, { error: "Not found" });
  if (!bearerMatches(request.headers.authorization, statsToken)) return reply(response, 401, { error: "Unauthorized" });
  reply(response, 200, metrics.snapshot());
}
function validPublishToken(header: string | undefined) { return bearerMatches(header, releasePublishToken); }
function bearerMatches(header: string | undefined, expected: string | undefined) {
  const supplied = header?.match(/^Bearer (.+)$/)?.[1];
  if (!supplied || !expected) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(supplied);
  return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}
function releaseVersion(value: string | string[] | undefined) { if (typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)) return value; throw new HttpError(400, "x-replay-release-version must be a semantic version such as 0.1.0."); }
function releasePlatform(value: string | string[] | undefined): Release["platform"] { if (value === "darwin-arm64") return value; throw new HttpError(400, "x-replay-release-platform must be darwin-arm64."); }
function compareVersions(left: string, right: string) { const a = left.split(".").map(Number); const b = right.split(".").map(Number); return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!; }
function releaseMetadata(origin: string, release: Release) { return { version: release.version, platform: release.platform, sha256: release.sha256, bytes: release.bytes, archiveUrl: `${origin}/v1/releases/${release.archive}` }; }
function requestOrigin(request: IncomingMessage) { return process.env.REPLAY_SHARE_PUBLIC_URL?.replace(/\/$/, "") ?? `http://${request.headers.host ?? `127.0.0.1:${port}`}`; }
function reply(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
