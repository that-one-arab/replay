import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { recHome, sessionPath, sessionsDir } from "./storage.js";
import type { RecordingManifest } from "./types.js";

export const PORTABLE_BUNDLE_VERSION = 1;

interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
  data: string;
}

interface PortableBundle {
  kind: "rec-portable-bundle";
  format_version: number;
  exported_at: string;
  manifest: RecordingManifest;
  manifest_sha256: string;
  files: BundleFile[];
}

export interface ExportResult {
  sessionId: string;
  path: string;
  bytes: number;
  fileCount: number;
}

export interface ImportResult {
  sessionId: string;
  path: string;
  fileCount: number;
}

/** Default handoff location for a self-contained portable recording. */
export function exportPath(sessionId: string) {
  return join(recHome(), "exports", `${sessionId}.rec`);
}

/**
 * Write a compressed, versioned portable bundle. The session remains untouched;
 * the resulting .rec file can be moved to another machine and imported there.
 */
export async function exportSession(sessionId: string, output = exportPath(sessionId)): Promise<ExportResult> {
  const root = sessionPath(sessionId);
  const manifest = await readManifest(root);
  if (manifest.id !== sessionId) throw new Error(`Session manifest ID does not match ${sessionId}.`);
  const paths = referencedPaths(manifest);
  if (existsSync(join(root, "markers.json"))) paths.push("markers.json");
  const files = await Promise.all(paths.map(async (path) => {
    const data = await readBundleFile(root, path);
    return { path, bytes: data.byteLength, sha256: digest(data), data: data.toString("base64") };
  }));
  const bundle: PortableBundle = {
    kind: "rec-portable-bundle",
    format_version: PORTABLE_BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    manifest,
    manifest_sha256: digest(Buffer.from(JSON.stringify(manifest))),
    files,
  };
  const encoded = gzipSync(Buffer.from(JSON.stringify(bundle)));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded, { flag: "wx" });
  return { sessionId, path: output, bytes: encoded.byteLength, fileCount: files.length };
}

/**
 * Verify then atomically install a portable recording in the local Rec spool.
 * Existing IDs are never overwritten: an artifact is either wholly imported or
 * rejected with its source recording left intact.
 */
export async function importSession(input: string): Promise<ImportResult> {
  const bundle = await readBundle(input);
  validateBundle(bundle);
  const root = sessionPath(bundle.manifest.id);
  if (existsSync(root)) throw new Error(`A recording named ${bundle.manifest.id} already exists locally.`);
  await mkdir(sessionsDir(), { recursive: true });
  const temporary = await mkdtemp(join(sessionsDir(), ".import-"));
  try {
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(bundle.manifest, null, 2) + "\n", { flag: "wx" });
    for (const file of bundle.files) {
      const target = safeTarget(temporary, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx" });
    }
    await rename(temporary, root);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { sessionId: bundle.manifest.id, path: root, fileCount: bundle.files.length };
}

async function readBundle(input: string): Promise<PortableBundle> {
  let decoded: Buffer;
  try { decoded = gunzipSync(await readFile(input)); } catch { throw new Error("Not a valid .rec bundle (expected gzip-compressed Rec data)."); }
  try { return JSON.parse(decoded.toString("utf8")) as PortableBundle; } catch { throw new Error("Not a valid .rec bundle (invalid JSON payload)."); }
}

function validateBundle(bundle: PortableBundle) {
  if (!bundle || bundle.kind !== "rec-portable-bundle" || bundle.format_version !== PORTABLE_BUNDLE_VERSION) throw new Error("Unsupported Rec bundle version.");
  if (!validManifest(bundle.manifest)) throw new Error("Portable bundle has an invalid recording manifest.");
  if (bundle.manifest_sha256 !== digest(Buffer.from(JSON.stringify(bundle.manifest)))) throw new Error("Portable bundle manifest checksum does not match.");
  if (!Array.isArray(bundle.files)) throw new Error("Portable bundle has no file list.");
  const expected = new Set(referencedPaths(bundle.manifest));
  const seen = new Set<string>();
  for (const file of bundle.files) {
    if (!file || typeof file.path !== "string" || typeof file.data !== "string" || typeof file.bytes !== "number" || typeof file.sha256 !== "string") throw new Error("Portable bundle has an invalid file entry.");
    if ((!expected.has(file.path) && file.path !== "markers.json") || seen.has(file.path) || !isSafeBundlePath(file.path)) throw new Error(`Portable bundle contains an unexpected file: ${file.path}`);
    const data = Buffer.from(file.data, "base64");
    if (data.byteLength !== file.bytes || digest(data) !== file.sha256) throw new Error(`Portable bundle checksum does not match for ${file.path}.`);
    seen.add(file.path);
  }
  for (const path of expected) if (!seen.has(path)) throw new Error(`Portable bundle is missing ${path}.`);
}

function validManifest(manifest: RecordingManifest | undefined): manifest is RecordingManifest {
  return Boolean(manifest && manifest.format_version === 1 && typeof manifest.id === "string" && /^[A-Za-z0-9_-]+$/.test(manifest.id) && Array.isArray(manifest.segments) && Array.isArray(manifest.assets));
}

function referencedPaths(manifest: RecordingManifest) {
  const paths = [...manifest.segments.flatMap((segment) => segment.chunks), ...manifest.assets.map((asset) => asset.path)];
  if (paths.some((path) => !isSafeBundlePath(path))) throw new Error("Recording manifest references an unsafe bundle path.");
  return [...new Set(paths)].sort();
}

async function readManifest(root: string) {
  try { return JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RecordingManifest; } catch { throw new Error(`Could not read recording manifest in ${basename(root)}.`); }
}

async function readBundleFile(root: string, path: string) { return readFile(safeTarget(root, path)); }
function digest(data: Uint8Array) { return createHash("sha256").update(data).digest("hex"); }
function isSafeBundlePath(path: string) { return /^(events\/[A-Za-z0-9_-]+-\d{4}\.jsonl\.gz|assets\/[a-f0-9]{64}|markers\.json)$/.test(path); }
function safeTarget(root: string, relative: string) {
  const target = resolve(root, relative);
  if (!isSafeBundlePath(relative) || !target.startsWith(`${resolve(root)}/`)) throw new Error(`Unsafe recording path: ${relative}`);
  return target;
}
