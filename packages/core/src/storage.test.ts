import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateActiveDuration, SessionStore } from "./storage.js";
import { rewriteAssetUrls } from "./recorder.js";

test("caps inactive gaps while preserving active event spans", () => {
  assert.equal(calculateActiveDuration([0, 1_000, 8_000]), 4_000);
});

test("returns zero for a single timestamp", () => {
  assert.equal(calculateActiveDuration([1_000]), 0);
});

test("rewrites captured resources and leaves an explicit unscoped iframe fallback", () => {
  const result = rewriteAssetUrls({
    node: {
      type: 2,
      tagName: "main",
      attributes: {},
      childNodes: [
        { type: 2, tagName: "img", attributes: { src: "/images/orbit.svg" }, childNodes: [] },
        { type: 2, tagName: "iframe", attributes: { src: "https://payments.example/checkout" }, childNodes: [] },
      ],
    },
  }, "https://app.example/onboarding", "rec_fixture", [{ id: "asset-image", source_urls: ["https://app.example/images/orbit.svg"] }], new Set(["https://app.example"])) as { node: { childNodes: { attributes: Record<string, string> }[] } };
  assert.equal(result.node.childNodes[0].attributes.src, "/api/sessions/rec_fixture/assets/asset-image");
  assert.equal(result.node.childNodes[1].attributes.src, "about:blank");
  assert.match(result.node.childNodes[1].attributes.srcdoc, /External frame unavailable/);
});

test("persists marker placement and reports captured event counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rec-storage-"));
  const previousHome = process.env.REC_HOME;
  process.env.REC_HOME = root;
  try {
    const store = await SessionStore.create({
      format_version: 1,
      id: "rec_marker_fixture",
      title: "Marker fixture",
      created_at: new Date().toISOString(),
      recorder: { version: "test", rrweb: "test", record_canvas: false, record_cross_origin_iframes: false },
      origins: ["http://example.test"],
      masking: { mask_all_inputs: false, passwords: true },
      segments: [],
      tab_events: [],
      markers: [],
      assets: [],
    });
    store.segment("seg_1", "http://example.test", 0);
    await store.append("seg_1", [{ type: 2, timestamp: 10 }, { type: 3, timestamp: 20 }], Date.now());
    store.addMarker({ t_ms: 25, label: "Ready to submit", placement: "before_next" });
    await store.finalize();
    assert.deepEqual(store.captureSummary(), { segmentCount: 1, chunkCount: 1, eventCount: 2 });
    const manifest = JSON.parse(await readFile(join(root, "sessions", "rec_marker_fixture", "manifest.json"), "utf8")) as { markers: { placement?: string }[] };
    assert.equal(manifest.markers[0]?.placement, "before_next");
  } finally {
    if (previousHome === undefined) delete process.env.REC_HOME;
    else process.env.REC_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
