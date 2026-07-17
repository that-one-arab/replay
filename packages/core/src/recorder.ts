import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { SessionStore } from "./storage.js";
import type { Marker, RecordingManifest, StartOptions, StopResult } from "./types.js";

const require = createRequire(import.meta.url);
const FLUSH_MS = 500;

interface PageState {
  id: string;
  page: Page;
  queue: unknown[];
  flushTimer?: NodeJS.Timeout;
}

/** One active recorder bound to an existing Chromium CDP endpoint. */
export class Recorder {
  private browser?: Browser;
  private context?: BrowserContext;
  private store?: SessionStore;
  private startedAt = 0;
  private readonly pages = new Map<Page, PageState>();
  private readonly knownPages = new Set<Page>();
  private observedPages = new WeakSet<Page>();
  private origins = new Set<string>();
  private initialized = false;

  async attach(cdpEndpoint: string) {
    if (this.browser) await this.browser.close();
    this.knownPages.clear();
    // Bindings belong to a single Playwright BrowserContext. Reattaching over
    // CDP creates a new context facade, so it must receive its own bridge.
    this.initialized = false;
    this.browser = await chromium.connectOverCDP(cdpEndpoint);
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error("No browser context found at CDP endpoint");
    this.context.on("page", (page) => this.registerPage(page));
    for (const page of this.context.pages()) this.registerPage(page);
    return this;
  }

  async start(options: StartOptions = {}) {
    if (!this.browser || !this.context) throw new Error("Recorder is not attached. Run rec attach first.");
    if (this.store) throw new Error("A recording is already active");
    const pages = [...new Set([...this.context.pages(), ...this.knownPages])];
    const active = pages.find((page) => page.url() !== "about:blank") ?? pages[0];
    const defaultOrigin = active ? originOf(active.url()) : undefined;
    const origins = options.origins?.length ? options.origins : defaultOrigin ? [defaultOrigin] : [];
    if (origins.length === 0) throw new Error("No page origin found. Navigate the browser or supply --origin.");
    this.origins = new Set(origins);
    this.startedAt = Date.now();
    this.observedPages = new WeakSet<Page>();
    const id = `rec_${randomUUID().slice(0, 8)}`;
    const manifest: RecordingManifest = {
      format_version: 1,
      id,
      title: options.title ?? "Untitled recording",
      created_at: new Date(this.startedAt).toISOString(),
      recorder: { version: "0.1.0", rrweb: "2.0.0-alpha.20" },
      origins,
      masking: { mask_all_inputs: Boolean(options.maskAllInputs), passwords: true },
      segments: [],
      markers: [],
    };
    this.store = await SessionStore.create(manifest);
    await this.installBindings();
    const injection = await recorderScript();
    await this.context.addInitScript({ content: injection });
    for (const page of pages) {
      // addInitScript only applies to documents created after registration.
      // Starting on an already-open page is the primary workflow, so inject the
      // exact same bundle before attempting to call its recorder API.
      if (inScope(page.url(), this.origins)) await page.evaluate(injection).catch(() => undefined);
      this.observePage(page);
    }
    return { sessionId: id };
  }

  async marker(label: string, note?: string) {
    if (!this.store) throw new Error("No recording is active");
    const marker: Marker = { t_ms: Date.now() - this.startedAt, label, note };
    this.store.addMarker(marker);
    await Promise.all([...this.pages.values()].map(async ({ page }) => {
      await page.evaluate(({ label, note }) => {
        const api = window as typeof window & { __recAddMarker?: (label: string, note?: string) => void };
        api.__recAddMarker?.(label, note);
      }, { label, note }).catch(() => undefined);
    }));
  }

  async stop(outcome?: RecordingManifest["outcome"], notes?: string): Promise<StopResult> {
    const store = this.requireStore();
    await Promise.all([...this.pages.values()].map((state) => this.flush(state)));
    for (const { page, flushTimer } of this.pages.values()) {
      if (flushTimer) clearTimeout(flushTimer);
      await page.evaluate(() => {
        const api = window as typeof window & { __recStop?: () => void };
        api.__recStop?.();
      }).catch(() => undefined);
    }
    await store.finalize(outcome, notes);
    const result: StopResult = {
      sessionId: store.manifest.id,
      path: store.root,
      rawDurationMs: store.manifest.raw_duration_ms ?? 0,
      activeDurationMs: store.manifest.active_duration_ms ?? 0,
      markers: store.manifest.markers,
    };
    this.pages.clear();
    this.store = undefined;
    return result;
  }

  status() {
    return this.store ? { state: "recording" as const, sessionId: this.store.manifest.id, elapsedMs: Date.now() - this.startedAt } : { state: "idle" as const };
  }

  async close() {
    if (this.store) await this.stop();
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
  }

  private async installBindings() {
    if (this.initialized || !this.context) return;
    await this.context.exposeBinding("__rec_emit", ({ page }, payload: unknown) => {
      // Playwright can rehydrate a CDP page target between sessions. Prefer
      // object identity, then resolve the active page by its current URL.
      const state = page ? this.pages.get(page) ?? [...this.pages.values()].find((candidate) => candidate.page.url() === page.url()) : undefined;
      if (!state || !Array.isArray(payload)) return;
      state.queue.push(...payload);
      if (!state.flushTimer) state.flushTimer = setTimeout(() => void this.flush(state), FLUSH_MS);
    });
    this.initialized = true;
  }

  private registerPage(page: Page) {
    if (this.knownPages.has(page)) return;
    this.knownPages.add(page);
    page.on("close", () => this.knownPages.delete(page));
    // New popup targets are announced after recording has started. The init
    // script already covers their next document, but they still need the
    // recorder's navigation observer to become their own segment.
    if (this.store) this.observePage(page);
  }

  private observePage(page: Page) {
    if (this.observedPages.has(page)) return;
    this.observedPages.add(page);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.activatePage(page);
    });
    void this.activatePage(page);
  }

  private async activatePage(page: Page) {
    if (!this.store || !inScope(page.url(), this.origins)) return;
    this.ensurePageState(page);
    await page.evaluate((config) => {
      const api = window as typeof window & { __recStart?: (config: { maskAllInputs: boolean }) => void };
      api.__recStart?.(config);
    }, { maskAllInputs: this.store.manifest.masking.mask_all_inputs }).catch(() => undefined);
  }

  private ensurePageState(page: Page) {
    const existing = this.pages.get(page);
    if (existing) return existing;
    const state: PageState = { id: `seg_${this.pages.size + 1}`, page, queue: [] };
    this.pages.set(page, state);
    this.store?.segment(state.id, page.url(), Date.now() - this.startedAt);
    page.on("close", () => void this.flush(state));
    return state;
  }

  private async flush(state: PageState) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
    const events = state.queue.splice(0);
    if (events.length > 0 && this.store) await this.store.append(state.id, events, Date.now());
  }

  private requireStore() {
    if (!this.store) throw new Error("No recording is active");
    return this.store;
  }
}

function originOf(url: string) {
  try { return new URL(url).origin; } catch { return undefined; }
}

function inScope(url: string, origins: Set<string>) {
  const origin = originOf(url);
  return Boolean(origin && origins.has(origin));
}

async function recorderScript() {
  // The package exports only its module entrypoint. Resolve that supported path
  // first, then select the adjacent browser-safe UMD bundle.
  const path = join(dirname(require.resolve("@rrweb/record")), "record.umd.min.cjs");
  const rrweb = await readFile(path, "utf8");
  return `${rrweb}\n;(() => {
    let stop; let buffer = []; let timer;
    const rrwebRecord = window.rrweb || window.rrwebRecord;
    const flush = () => { if (buffer.length) window.__rec_emit(buffer.splice(0)); if (timer) { clearTimeout(timer); timer = undefined; } };
    window.__recStart = ({ maskAllInputs }) => {
      if (stop || !rrwebRecord) return;
      stop = rrwebRecord.record({
        emit(event) { buffer.push(event); if (buffer.length >= 200) flush(); else if (!timer) timer = setTimeout(flush, ${FLUSH_MS}); },
        checkoutEveryNms: 60000,
        inlineStylesheet: true,
        collectFonts: true,
        slimDOM: true,
        maskAllInputs,
        maskInputOptions: { password: true },
        sampling: { mousemove: 50, scroll: 150 },
      });
    };
    window.__recAddMarker = (label, note) => rrwebRecord?.record?.addCustomEvent?.("rec-marker", { label, note });
    window.__recStop = () => { flush(); stop?.(); stop = undefined; };
  })();`;
}
