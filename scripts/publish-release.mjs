import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [archiveInput] = process.argv.slice(2);
const endpoint = process.env.REPLAY_RELEASE_PUBLISH_URL?.replace(/\/$/, "") ?? "https://share.replaythis.io";
const token = process.env.REPLAY_RELEASE_PUBLISH_TOKEN ?? (process.env.REPLAY_RELEASE_PUBLISH_TOKEN_FILE ? (await readFile(process.env.REPLAY_RELEASE_PUBLISH_TOKEN_FILE, "utf8")).trim() : undefined);
if (!archiveInput) throw new Error("Usage: REPLAY_RELEASE_PUBLISH_TOKEN=<token> node scripts/publish-release.mjs <archive.tar.gz>");
if (!token) throw new Error("REPLAY_RELEASE_PUBLISH_TOKEN or REPLAY_RELEASE_PUBLISH_TOKEN_FILE is required.");
const archive = resolve(archiveInput);
const match = /^replay-(\d+\.\d+\.\d+)-(darwin-arm64)\.tar\.gz$/.exec(basename(archive));
if (!match) throw new Error("Archive name must be replay-<version>-darwin-arm64.tar.gz.");
const response = await fetch(`${endpoint}/v1/releases`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "x-replay-release-version": match[1],
    "x-replay-release-platform": match[2],
    "content-type": "application/gzip",
  },
  body: await readFile(archive),
});
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Release publish failed with ${response.status}.`);
console.log(JSON.stringify(result, null, 2));
