import assert from "node:assert/strict";
import test from "node:test";
import { rewriteAssetUrls } from "./recorder.js";

const BASE = "http://127.0.0.1:5173/";
const ASSETS = [
  { id: "a1", source_urls: ["http://127.0.0.1:5173/logo.png"] },
  { id: "a2", source_urls: ["http://127.0.0.1:5173/logo@2x.png"] },
];
const ORIGINS = new Set(["http://127.0.0.1:5173"]);

test("rewrites every captured srcset candidate to its bundled asset path", () => {
  const node = { tagName: "img", attributes: { srcset: "logo.png 1x, logo@2x.png 2x" } };
  const result = rewriteAssetUrls(node, BASE, "r1", ASSETS, ORIGINS) as { attributes: { srcset: string } };
  assert.equal(result.attributes.srcset, "/api/sessions/r1/assets/a1 1x, /api/sessions/r1/assets/a2 2x");
});

test("leaves uncaptured srcset candidates pointing at their original URL", () => {
  const node = { tagName: "img", attributes: { srcset: "logo.png 1x, missing.png 2x" } };
  const result = rewriteAssetUrls(node, BASE, "r1", ASSETS, ORIGINS) as { attributes: { srcset: string } };
  assert.equal(result.attributes.srcset, "/api/sessions/r1/assets/a1 1x, missing.png 2x");
});

test("rewrites imagesrcset the same way as srcset", () => {
  const node = { tagName: "link", attributes: { rel: "preload", as: "image", imagesrcset: "logo.png 1x" } };
  const result = rewriteAssetUrls(node, BASE, "r1", ASSETS, ORIGINS) as { attributes: { imagesrcset: string } };
  assert.equal(result.attributes.imagesrcset, "/api/sessions/r1/assets/a1 1x");
});
