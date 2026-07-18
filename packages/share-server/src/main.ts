import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { importSession, sessionPath, type RecordingManifest } from "../../core/dist/index.js";

const port = Number(process.env.PORT ?? 8080);
const dataDir = resolve(process.env.REC_SHARE_DATA_DIR ?? "./.rec-share");
// The core importer intentionally uses REC_HOME. This process owns that spool
// exclusively, separate from the local recorder's home.
process.env.REC_HOME = join(dataDir, "spool");
const uploadsDir = join(dataDir, "uploads");
const sharesPath = join(dataDir, "shares.json");
const maxUploadBytes = Number(process.env.REC_SHARE_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);

type Share = { id: string; session_id: string; title: string; created_at: string; bytes: number };

const server = createServer((request, response) => void route(request, response).catch((error: unknown) => reply(response, 500, { error: messageOf(error) })));
server.listen(port, "0.0.0.0", () => console.log(`rec share server listening on http://0.0.0.0:${port}`));

async function route(request: IncomingMessage, response: ServerResponse) {
  const origin = requestOrigin(request);
  const url = new URL(request.url ?? "/", origin);
  if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
  if (request.method === "POST" && url.pathname === "/v1/recordings") return upload(request, response, origin);
  const shared = /^\/r\/([a-f0-9]{24})$/.exec(url.pathname);
  if (request.method === "GET" && shared) return redirectToShare(response, shared[1]);
  const replay = /^\/api\/sessions\/([^/]+)\/(manifest|events)$/.exec(url.pathname);
  if (request.method === "GET" && replay) return serveRecording(response, decodeURIComponent(replay[1]), replay[2], url.searchParams.get("segment"));
  const asset = /^\/api\/sessions\/([^/]+)\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
  if (request.method === "GET" && asset) return serveRecordedAsset(response, decodeURIComponent(asset[1]), asset[2]);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return servePlayerAsset(response, url.pathname);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/replay")) return servePlayer(response);
  reply(response, 404, { error: "Not found" });
}

async function upload(request: IncomingMessage, response: ServerResponse, origin: string) {
  const body = await binaryBody(request);
  await mkdir(uploadsDir, { recursive: true });
  const temporary = join(uploadsDir, `${randomBytes(12).toString("hex")}.rec`);
  await writeFile(temporary, body, { flag: "wx" });
  try {
    const imported = await importSession(temporary);
    const manifest = await readManifest(imported.sessionId);
    const share: Share = { id: randomBytes(12).toString("hex"), session_id: imported.sessionId, title: manifest.title, created_at: new Date().toISOString(), bytes: body.byteLength };
    const shares = await readShares();
    shares.push(share);
    await writeShares(shares);
    return reply(response, 201, { shareId: share.id, sessionId: share.session_id, shareUrl: `${origin}/r/${share.id}` });
  } finally {
    await rm(temporary, { force: true });
  }
}

async function redirectToShare(response: ServerResponse, shareId: string) {
  const share = (await readShares()).find((entry) => entry.id === shareId);
  if (!share) return reply(response, 404, { error: "Recording share not found" });
  response.writeHead(302, { location: `/replay?id=${encodeURIComponent(share.session_id)}`, "cache-control": "no-store" });
  response.end();
}

async function serveRecording(response: ServerResponse, id: string, resource: string, selected: string | null) {
  const manifest = await readManifest(id);
  if (resource === "manifest") return reply(response, 200, manifest);
  const segments = selected ? manifest.segments.filter((segment) => segment.id === selected) : manifest.segments;
  const events: unknown[] = [];
  for (const segment of segments) for (const chunk of segment.chunks) {
    const text = gunzipSync(await readFile(join(sessionPath(id), chunk))).toString("utf8");
    for (const line of text.trim().split("\n")) if (line) events.push(JSON.parse(line).event);
  }
  reply(response, 200, events);
}

async function serveRecordedAsset(response: ServerResponse, id: string, assetId: string) {
  const manifest = await readManifest(id);
  const asset = manifest.assets.find((entry) => entry.id === assetId);
  if (!asset) return reply(response, 404, { error: "Recorded asset not found" });
  const root = sessionPath(id);
  const path = resolve(root, asset.path);
  if (!path.startsWith(`${resolve(root, "assets")}/`) || !existsSync(path)) return reply(response, 404, { error: "Recorded asset file not found" });
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

async function readManifest(id: string) { return JSON.parse(await readFile(join(sessionPath(id), "manifest.json"), "utf8")) as RecordingManifest; }
async function readShares() { try { return JSON.parse(await readFile(sharesPath, "utf8")) as Share[]; } catch { return []; } }
async function writeShares(shares: Share[]) {
  await mkdir(dirname(sharesPath), { recursive: true });
  const temporary = `${sharesPath}.tmp`;
  await writeFile(temporary, JSON.stringify(shares, null, 2) + "\n");
  await rename(temporary, sharesPath);
}
function binaryBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > maxUploadBytes) { request.destroy(new Error(`Recording exceeds the ${maxUploadBytes} byte upload limit.`)); return; } chunks.push(chunk); });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
function requestOrigin(request: IncomingMessage) { return process.env.REC_SHARE_PUBLIC_URL?.replace(/\/$/, "") ?? `http://${request.headers.host ?? `127.0.0.1:${port}`}`; }
function reply(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
