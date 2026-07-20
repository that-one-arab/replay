import assert from "node:assert/strict";
import test from "node:test";
import type { ReplayEvent } from "./types.js";
import { isFetchableAbsolute, sanitizeReplayEvents } from "./sanitize.js";

function snapshot(node: unknown): ReplayEvent {
  return { timestamp: 0, type: 2, data: { node } } as unknown as ReplayEvent;
}

test("isFetchableAbsolute flags only absolute-origin URLs", () => {
  assert.equal(isFetchableAbsolute("http://127.0.0.1:5173/a.png"), true);
  assert.equal(isFetchableAbsolute("https://cdn.example.com/a.png"), true);
  assert.equal(isFetchableAbsolute("//cdn.example.com/a.png"), true);
  assert.equal(isFetchableAbsolute("/api/sessions/x/assets/y"), false);
  assert.equal(isFetchableAbsolute("assets/y.png"), false);
  assert.equal(isFetchableAbsolute("data:image/png;base64,AAAA"), false);
  assert.equal(isFetchableAbsolute("#frag"), false);
  assert.equal(isFetchableAbsolute(""), false);
});

test("blanks an absolute image src but keeps rewritten relative assets", () => {
  const [event] = sanitizeReplayEvents([
    snapshot({
      tagName: "div",
      attributes: {},
      childNodes: [
        { tagName: "img", attributes: { src: "http://127.0.0.1:5173/logo.png" }, childNodes: [] },
        { tagName: "img", attributes: { src: "/api/sessions/r1/assets/a1" }, childNodes: [] },
      ],
    }),
  ]);
  const [leaked, local] = (event.data as { node: { childNodes: { attributes: { src: string } }[] } }).node.childNodes;
  assert.equal(leaked.attributes.src.startsWith("data:image/gif"), true);
  assert.equal(local.attributes.src, "/api/sessions/r1/assets/a1");
});

test("drops absolute srcset candidates, retains relative ones", () => {
  const [event] = sanitizeReplayEvents([
    snapshot({ tagName: "img", attributes: { srcset: "http://127.0.0.1:5173/a.png 1x, /api/sessions/r1/assets/a2 2x" }, childNodes: [] }),
  ]);
  const srcset = (event.data as { node: { attributes: { srcset: string } } }).node.attributes.srcset;
  assert.equal(srcset, "/api/sessions/r1/assets/a2 2x");
});

test("neutralizes url() and @import inside inlined stylesheet text and style attributes", () => {
  const [event] = sanitizeReplayEvents([
    snapshot({
      tagName: "div",
      attributes: { style: "background:url('http://127.0.0.1:5173/bg.png')" },
      childNodes: [
        { tagName: "style", attributes: {}, childNodes: [{ textContent: "@import url(http://127.0.0.1:5173/x.css);\n.a{background:url(http://127.0.0.1:5173/y.png)}" }] },
      ],
    }),
  ]);
  const node = (event.data as { node: { attributes: { style: string }; childNodes: { childNodes: { textContent: string }[] }[] } }).node;
  assert.equal(node.attributes.style.includes("127.0.0.1"), false);
  const css = node.childNodes[0].childNodes[0].textContent;
  assert.equal(css.includes("127.0.0.1"), false);
  assert.equal(css.includes("@import"), false);
});

test("drops uncaptured @font-face sources instead of feeding the browser image bytes", () => {
  const css = [
    "@font-face {\n  font-family: 'Almarai';\n  src: url(http://localhost:3000/fonts/almarai.woff2) format('woff2'), url(http://localhost:3000/fonts/almarai.woff) format('woff');\n  font-display: swap;\n}",
    "@font-face { font-family: 'Inter'; src: url('/api/sessions/r1/assets/a3') format('woff2'); }",
    "@font-face { font-family: 'Mixed'; src: local('Mixed'), url(https://cdn.example.com/mixed.woff2) format('woff2'); }",
    "@font-face { font-family: 'Data'; src: url(data:font/woff2;base64,AA,BB) format('woff2'); }",
    ".hero { background: url(http://localhost:3000/bg.png); }",
  ].join("\n");
  const [event] = sanitizeReplayEvents([
    snapshot({ tagName: "style", attributes: {}, childNodes: [{ textContent: css }] }),
  ]);
  const out = (event.data as { node: { childNodes: { textContent: string }[] } }).node.childNodes[0].textContent;
  // No @font-face slot may point at the blank image — that is what the browser
  // would try (and endlessly fail) to decode as a font.
  assert.equal(/@font-face[^}]*data:image\/gif/.test(out), false);
  assert.equal(out.includes("localhost"), false);
  // Fully uncaptured family degrades to a silent local() miss.
  assert.equal(out.includes('local("replay-uncaptured-font")'), true);
  // Captured relative, local() and data: candidates survive untouched.
  assert.equal(out.includes("url('/api/sessions/r1/assets/a3') format('woff2')"), true);
  assert.equal(out.includes("local('Mixed')"), true);
  assert.equal(out.includes("url(data:font/woff2;base64,AA,BB) format('woff2')"), true);
  // Non-font CSS still falls back to the blank image.
  assert.equal(out.includes(".hero { background: url(data:image/gif"), true);
});

test("leaves navigational anchor href untouched but blanks link href", () => {
  const [event] = sanitizeReplayEvents([
    snapshot({
      tagName: "div",
      attributes: {},
      childNodes: [
        { tagName: "a", attributes: { href: "http://127.0.0.1:5173/page" }, childNodes: [] },
        { tagName: "link", attributes: { rel: "icon", href: "http://127.0.0.1:5173/favicon.ico" }, childNodes: [] },
      ],
    }),
  ]);
  const [anchor, link] = (event.data as { node: { childNodes: { attributes: { href: string } }[] } }).node.childNodes;
  assert.equal(anchor.attributes.href, "http://127.0.0.1:5173/page");
  assert.equal(link.attributes.href, "about:blank");
});

test("sanitizes absolute src in incremental add and attribute mutations", () => {
  const events: ReplayEvent[] = [
    { timestamp: 1, type: 3, data: { adds: [{ parentId: 1, nextId: null, node: { tagName: "img", attributes: { src: "http://127.0.0.1:5173/late.png" }, childNodes: [] } }] } } as unknown as ReplayEvent,
    { timestamp: 2, type: 3, data: { attributes: [{ id: 5, attributes: { src: "http://127.0.0.1:5173/swap.png", href: "http://127.0.0.1:5173/keep" } }] } } as unknown as ReplayEvent,
  ];
  const [add, attr] = sanitizeReplayEvents(events);
  // The added node carries its tag, so an <img> src falls back to a blank image.
  assert.equal((add.data as { adds: { node: { attributes: { src: string } } }[] }).adds[0].node.attributes.src.startsWith("data:image/gif"), true);
  const mutated = (attr.data as { attributes: { attributes: { src: string; href: string } }[] }).attributes[0].attributes;
  // A mutation has no tag context, so src is neutralized to about:blank — either
  // way the captured localhost origin is gone and no fetch is issued.
  assert.equal(mutated.src, "about:blank");
  assert.equal(mutated.src.includes("127.0.0.1"), false);
  // href is ambiguous without a tag in a mutation, so it is left as-is.
  assert.equal(mutated.href, "http://127.0.0.1:5173/keep");
});

test("returns events untouched when nothing is fetchable", () => {
  const clean = snapshot({ tagName: "img", attributes: { src: "/api/sessions/r1/assets/a1" }, childNodes: [] });
  const [out] = sanitizeReplayEvents([clean]);
  assert.equal(out, clean);
});
