import assert from "node:assert/strict";
import test from "node:test";
import { calculateActiveDuration } from "./storage.js";
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
