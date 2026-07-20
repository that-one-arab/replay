import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page, Request as PlaywrightRequest } from "playwright-core";
import { Capture } from "./capture.js";
import { calculateActiveDuration, SessionStore } from "./storage.js";
import { exportSession, importSession } from "./bundle.js";
import { rewriteAssetUrls } from "./capture.js";

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
  }, "https://app.example/onboarding", "replay_fixture", [{ id: "asset-image", source_urls: ["https://app.example/images/orbit.svg"] }], new Set(["https://app.example"])) as { node: { childNodes: { attributes: Record<string, string> }[] } };
  assert.equal(result.node.childNodes[0].attributes.src, "/api/sessions/replay_fixture/assets/asset-image");
  assert.equal(result.node.childNodes[1].attributes.src, "about:blank");
  assert.match(result.node.childNodes[1].attributes.srcdoc, /External frame unavailable/);
});

test("persists marker placement and reports captured event counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-storage-"));
  const previousHome = process.env.REPLAY_HOME;
  process.env.REPLAY_HOME = root;
  try {
    const store = await SessionStore.create({
      format_version: 1,
      id: "replay_marker_fixture",
      title: "Marker fixture",
      created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false },
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
    store.addAction({ id: "act_1", tool: "browser_click", args_summary: "{\"selector\":\"#submit\"}", started_at_ms: 15, finished_at_ms: 22, ok: true });
    store.addMarker({ t_ms: 22, label: "Submitted", action_id: "act_1" });
    store.addNavigationEvent({
      segment_id: "seg_1",
      kind: "reload",
      started_at_ms: 30,
      committed_at_ms: 80,
      ready_at_ms: 120,
      from_url: "http://example.test/todos",
      to_url: "http://example.test/todos",
    });
    await store.finalize();
    assert.deepEqual(store.captureSummary(), { segmentCount: 1, chunkCount: 1, eventCount: 2 });
    const manifest = JSON.parse(await readFile(join(root, "sessions", "replay_marker_fixture", "manifest.json"), "utf8")) as { markers: { placement?: string; action_id?: string }[]; actions?: { id: string; tool: string; ok: boolean }[]; navigation_events?: { kind: string; ready_at_ms: number }[] };
    assert.equal(manifest.markers[0]?.placement, "before_next");
    assert.equal(manifest.markers[1]?.action_id, "act_1");
    assert.deepEqual(manifest.actions, [{ id: "act_1", tool: "browser_click", args_summary: "{\"selector\":\"#submit\"}", started_at_ms: 15, finished_at_ms: 22, ok: true }]);
    assert.deepEqual(manifest.navigation_events, [{
      segment_id: "seg_1",
      kind: "reload",
      started_at_ms: 30,
      committed_at_ms: 80,
      ready_at_ms: 120,
      from_url: "http://example.test/todos",
      to_url: "http://example.test/todos",
    }]);
  } finally {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("captures a completed top-level reload as manifest navigation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-navigation-"));
  const previousHome = process.env.REPLAY_HOME;
  process.env.REPLAY_HOME = root;
  try {
    const store = await SessionStore.create({
      format_version: 1,
      id: "replay_navigation_fixture",
      title: "Navigation fixture",
      created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false },
      origins: ["http://example.test"],
      masking: { mask_all_inputs: false, passwords: true },
      segments: [],
      tab_events: [],
      navigation_events: [],
      markers: [],
      assets: [],
    });
    store.segment("seg_1", "http://example.test/todos", 0);
    const frame = {};
    const page = { mainFrame: () => frame } as unknown as Page;
    const capture = new Capture();
    const internals = capture as unknown as {
      store?: SessionStore;
      startedAt: number;
      pages: Map<Page, { id: string; page: Page; baseUrl: string }>;
      observeNavigationRequest(page: Page, request: PlaywrightRequest): void;
      commitNavigation(page: Page, url: string): void;
    };
    internals.store = store;
    internals.startedAt = Date.now() - 100;
    const state = { id: "seg_1", page, baseUrl: "http://example.test/todos" };
    internals.pages.set(page, state);
    const request = {
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => "http://example.test/todos",
    } as unknown as PlaywrightRequest;
    internals.observeNavigationRequest(page, request);
    // Navigation events finalize on commit (no rrweb full-snapshot gate), so a
    // reload that commits is recorded immediately.
    internals.commitNavigation(page, "http://example.test/todos");
    const events = store.manifest.navigation_events ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "reload");
    assert.equal(events[0]?.from_url, "http://example.test/todos");
    assert.equal(events[0]?.to_url, "http://example.test/todos");
    assert.equal(events[0]?.ready_at_ms, events[0]?.committed_at_ms);
    assert.ok((events[0]?.started_at_ms ?? -1) <= (events[0]?.committed_at_ms ?? -1));
  } finally {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("does not splice a stale pending navigation into a later one", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-navigation-stale-"));
  const previousHome = process.env.REPLAY_HOME;
  process.env.REPLAY_HOME = root;
  try {
    const store = await SessionStore.create({
      format_version: 1,
      id: "replay_navigation_stale_fixture",
      title: "Stale navigation fixture",
      created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false },
      origins: ["http://example.test"],
      masking: { mask_all_inputs: false, passwords: true },
      segments: [],
      tab_events: [],
      navigation_events: [],
      markers: [],
      assets: [],
    });
    store.segment("seg_1", "http://example.test/a", 0);
    const frame = {};
    const page = { mainFrame: () => frame } as unknown as Page;
    const capture = new Capture();
    const internals = capture as unknown as {
      store?: SessionStore;
      startedAt: number;
      pages: Map<Page, { id: string; page: Page; baseUrl: string }>;
      pendingNavigations: Map<Page, { fromUrl: string; toUrl: string; startedAtMs: number }>;
      observeNavigationRequest(page: Page, request: PlaywrightRequest): void;
      commitNavigation(page: Page, url: string): void;
    };
    internals.store = store;
    internals.startedAt = Date.now() - 100;
    const state = { id: "seg_1", page, baseUrl: "http://example.test/a" };
    internals.pages.set(page, state);
    const navRequest = (url: string) => ({ isNavigationRequest: () => true, frame: () => frame, url: () => url }) as unknown as PlaywrightRequest;
    // A navigation request opens a pending but never commits (an aborted load
    // or a phantom client-side route). Age it past the stale window.
    internals.observeNavigationRequest(page, navRequest("http://example.test/phantom"));
    internals.pendingNavigations.get(page)!.startedAtMs = -10_000;
    // A later, unrelated navigation commits. It must start fresh — not inherit
    // the phantom's start time or destination.
    internals.observeNavigationRequest(page, navRequest("http://example.test/b"));
    internals.commitNavigation(page, "http://example.test/b");
    const events = store.manifest.navigation_events ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.from_url, "http://example.test/a");
    assert.equal(events[0]?.to_url, "http://example.test/b");
    assert.ok((events[0]?.started_at_ms ?? -1) > 0, "started_at_ms was reset rather than inherited from the phantom");
    assert.ok((events[0]?.started_at_ms ?? -1) <= (events[0]?.committed_at_ms ?? -1));
  } finally {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a complete replay and imports it with verified chunks and assets", async () => {
  const source = await mkdtemp(join(tmpdir(), "replay-export-source-"));
  const target = await mkdtemp(join(tmpdir(), "replay-export-target-"));
  const artifact = join(source, "handoff.replay");
  const previousHome = process.env.REPLAY_HOME;
  try {
    process.env.REPLAY_HOME = source;
    const store = await SessionStore.create({
      format_version: 1, id: "replay_portable_fixture", title: "Portable fixture", created_at: new Date().toISOString(),
      capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false }, origins: ["http://example.test"], masking: { mask_all_inputs: false, passwords: true }, segments: [], tab_events: [], markers: [], assets: [],
    });
    store.segment("seg_1", "http://example.test", 0);
    await store.append("seg_1", [{ type: 2, timestamp: 1 }, { type: 3, timestamp: 2 }], Date.now());
    await store.addAsset("http://example.test/icon.svg", Buffer.from("asset"), "image/svg+xml");
    await store.finalize();
    const exported = await exportSession("replay_portable_fixture", artifact);
    assert.equal(exported.fileCount, 3);
    await assert.rejects(exportSession("replay_portable_fixture", artifact), /EEXIST/);
    process.env.REPLAY_HOME = target;
    const imported = await importSession(artifact);
    assert.equal(imported.sessionId, "replay_portable_fixture");
    assert.equal(await readFile(join(target, "sessions", imported.sessionId, "assets", store.manifest.assets[0]!.id), "utf8"), "asset");
    await assert.rejects(importSession(artifact), /already exists/);
    await writeFile(artifact, Buffer.from("invalid"));
    await assert.rejects(importSession(artifact), /Not a valid .replay bundle/);
  } finally {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
