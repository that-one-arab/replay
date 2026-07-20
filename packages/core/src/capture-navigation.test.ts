import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page, Request as PlaywrightRequest } from "playwright-core";
import { Capture } from "./capture.js";
import { SessionStore } from "./storage.js";
import type { NavigationEvent } from "./types.js";

// Regression suite for navigation-event tracking. The capture records one
// NavigationEvent per real main-frame navigation, finalizing on commit (not on
// an rrweb full snapshot) and never reusing a pending across distinct
// navigations. See capture.ts: commitNavigation / observeNavigationRequest /
// expireStalePending.

const ORIGIN = "http://example.test";

interface NavigationHarness {
  events: () => NavigationEvent[];
  request: (url: string) => void;
  commit: (url: string) => void;
  setBaseUrl: (url: string) => void;
  pendingStartedAtMs: () => number | undefined;
  agePendingStale: () => void;
  advanceClock: (ms: number) => void;
}

interface CaptureInternals {
  store?: SessionStore;
  startedAt: number;
  pages: Map<Page, { id: string; page: Page; baseUrl: string }>;
  pendingNavigations: Map<Page, { fromUrl: string; toUrl: string; startedAtMs: number }>;
  observeNavigationRequest(page: Page, request: PlaywrightRequest): void;
  commitNavigation(page: Page, url: string): void;
}

async function setupNavigation(initialUrl: string): Promise<{ harness: NavigationHarness; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "replay-navigation-"));
  const previousHome = process.env.REPLAY_HOME;
  process.env.REPLAY_HOME = root;
  const store = await SessionStore.create({
    format_version: 1,
    id: "replay_navigation_test",
    title: "Navigation tracking fixture",
    created_at: new Date().toISOString(),
    capture: { version: "test", rrweb: "test", capture_canvas: false, capture_cross_origin_iframes: false },
    origins: [ORIGIN],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [],
    tab_events: [],
    navigation_events: [],
    markers: [],
    assets: [],
  });
  store.segment("seg_1", initialUrl, 0);
  const frame = {};
  const page = { mainFrame: () => frame } as unknown as Page;
  const internals = new Capture() as unknown as CaptureInternals;
  internals.store = store;
  internals.startedAt = Date.now() - 100;
  internals.pages.set(page, { id: "seg_1", page, baseUrl: initialUrl });
  const navRequest = (url: string) => ({ isNavigationRequest: () => true, frame: () => frame, url: () => url }) as unknown as PlaywrightRequest;
  const harness: NavigationHarness = {
    events: () => store.manifest.navigation_events ?? [],
    request: (url) => internals.observeNavigationRequest(page, navRequest(url)),
    commit: (url) => internals.commitNavigation(page, url),
    setBaseUrl: (url) => { internals.pages.get(page)!.baseUrl = url; },
    pendingStartedAtMs: () => internals.pendingNavigations.get(page)?.startedAtMs,
    // Force the in-flight pending past the stale window without waiting on the
    // real clock: expireStalePending measures elapsed wall time since start.
    agePendingStale: () => { const pending = internals.pendingNavigations.get(page); if (pending) pending.startedAtMs = -10_000; },
    // Simulate capture time elapsing so successive navigations land outside the
    // store's 100ms committed-time dedup window (the real clock barely moves
    // between synchronous calls in the test).
    advanceClock: (ms) => { internals.startedAt -= ms; },
  };
  const cleanup = async () => {
    if (previousHome === undefined) delete process.env.REPLAY_HOME;
    else process.env.REPLAY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  };
  return { harness, cleanup };
}

test("finalizes a navigation on frame commit without an rrweb full snapshot", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // Before this change, emission waited for an rrweb type-2 full snapshot that
    // SPAs never produce for client-side routes. A committed navigation must now
    // be recorded with no snapshot fed at all.
    harness.request(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);
    const events = harness.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.to_url, `${ORIGIN}/b`);
  } finally {
    await cleanup();
  }
});

test("records two successive navigations as separate events instead of merging them", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // The original bug: a pending opened by the first navigation lingered (no
    // finalizing snapshot) and was reused by the second, producing one record
    // that spliced the first navigation's start onto the second's commit — a
    // 39-second "transition" covering the whole climax.
    harness.request(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);
    harness.advanceClock(200); // successive navigations are seconds apart, not same-tick
    harness.setBaseUrl(`${ORIGIN}/b`); // rrweb advances baseUrl between navigations
    harness.request(`${ORIGIN}/c`);
    harness.commit(`${ORIGIN}/c`);

    const events = harness.events();
    assert.equal(events.length, 2, "each navigation gets its own event, not one merged span");
    assert.equal(events[0]?.from_url, `${ORIGIN}/a`);
    assert.equal(events[0]?.to_url, `${ORIGIN}/b`);
    assert.equal(events[1]?.from_url, `${ORIGIN}/b`);
    assert.equal(events[1]?.to_url, `${ORIGIN}/c`);
    // The second navigation must start at or after the first commits — it did
    // not inherit the first's pending. (The chimera had started[1] ≈ started[0].)
    assert.ok((events[1]?.started_at_ms ?? -1) >= (events[0]?.committed_at_ms ?? -1), "second navigation starts after the first commits");
    // Each transition is tight and self-consistent, not a long merged span.
    for (const event of events) {
      assert.ok((event.committed_at_ms - event.started_at_ms) < 1_000, `navigation span is tight: ${event.committed_at_ms - event.started_at_ms}ms`);
    }
  } finally {
    await cleanup();
  }
});

test("does not inherit a stale pending navigation's start time or destination", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // A request that never commits (aborted load or phantom client-side route)
    // is aged past the stale window. The next real navigation must start fresh.
    harness.request(`${ORIGIN}/phantom`);
    harness.agePendingStale();
    harness.request(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);

    const events = harness.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.from_url, `${ORIGIN}/a`);
    assert.equal(events[0]?.to_url, `${ORIGIN}/b`);
    assert.ok((events[0]?.started_at_ms ?? -1) > 0, "started_at_ms was reset rather than inherited from the phantom");
  } finally {
    await cleanup();
  }
});

test("preserves the start time and final url across a redirect chain", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    harness.request(`${ORIGIN}/b`);
    const startedAtFirstRequest = harness.pendingStartedAtMs();
    // A redirect chains a second request into the same in-flight navigation;
    // the destination moves to the final url but the start time is preserved.
    harness.request(`${ORIGIN}/c`);
    harness.commit(`${ORIGIN}/c`);

    const events = harness.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.from_url, `${ORIGIN}/a`);
    assert.equal(events[0]?.to_url, `${ORIGIN}/c`, "final destination wins");
    assert.equal(events[0]?.started_at_ms, startedAtFirstRequest, "start time is preserved across the redirect chain");
  } finally {
    await cleanup();
  }
});

test("sets ready_at_ms equal to committed_at_ms", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // Finalize-on-commit no longer refines ready from an rrweb snapshot.
    harness.request(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);
    const [event] = harness.events();
    assert.ok(event);
    assert.equal(event.ready_at_ms, event.committed_at_ms);
  } finally {
    await cleanup();
  }
});

test("marks same-document transitions as reloads and cross-document as navigates", async () => {
  const { harness: reload, cleanup: cleanupReload } = await setupNavigation(`${ORIGIN}/page`);
  try {
    reload.request(`${ORIGIN}/page`);
    reload.commit(`${ORIGIN}/page`);
    assert.equal(reload.events()[0]?.kind, "reload");
  } finally {
    await cleanupReload();
  }

  const { harness: navigate, cleanup: cleanupNavigate } = await setupNavigation(`${ORIGIN}/page`);
  try {
    navigate.request(`${ORIGIN}/other`);
    navigate.commit(`${ORIGIN}/other`);
    assert.equal(navigate.events()[0]?.kind, "navigate");
  } finally {
    await cleanupNavigate();
  }
});

test("collapses duplicate rapid commits for one navigation to a single event", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // framenavigated can fire more than once for a single navigation (interim
    // documents, bfcache). Finalize-on-commit emits per commit; the store's
    // committed-time dedup must keep it to one record.
    harness.request(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);
    harness.commit(`${ORIGIN}/b`);
    assert.equal(harness.events().length, 1);
  } finally {
    await cleanup();
  }
});

test("records a commit that had no preceding navigation request", async () => {
  const { harness, cleanup } = await setupNavigation(`${ORIGIN}/a`);
  try {
    // commitNavigation falls back to a fresh pending when no request opened one
    // (e.g., a frame navigation whose request was not classified as such).
    harness.commit(`${ORIGIN}/b`);
    const [event] = harness.events();
    assert.ok(event);
    assert.equal(event.from_url, `${ORIGIN}/a`);
    assert.equal(event.to_url, `${ORIGIN}/b`);
    assert.equal(event.started_at_ms, event.committed_at_ms);
  } finally {
    await cleanup();
  }
});
