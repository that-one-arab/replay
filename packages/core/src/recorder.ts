import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Frame, Page, Response as PlaywrightResponse } from "playwright-core";
import { chromium } from "playwright-core";
import { SessionStore } from "./storage.js";
import type { Marker, RecordingManifest, StartOptions, StopResult } from "./types.js";

const require = createRequire(import.meta.url);
const FLUSH_MS = 500;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const STATIC_RESOURCE_TYPES = new Set(["stylesheet", "image", "font"]);

interface PageState {
  id: string;
  page: Page;
  queue: unknown[];
  baseUrl: string;
  clockOffsetMs: number;
  firstEventTimestamp?: number;
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
  private readonly assetCaptures = new Map<string, Promise<void>>();
  private origins = new Set<string>();
  private recordCanvas = false;
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
    this.recordCanvas = Boolean(options.recordCanvas);
    this.startedAt = Date.now();
    this.observedPages = new WeakSet<Page>();
    this.assetCaptures.clear();
    const id = `rec_${randomUUID().slice(0, 8)}`;
    const manifest: RecordingManifest = {
      format_version: 1,
      id,
      title: options.title ?? "Untitled recording",
      created_at: new Date(this.startedAt).toISOString(),
      recorder: { version: "0.1.0", rrweb: "2.0.0-alpha.20", record_canvas: this.recordCanvas, record_cross_origin_iframes: this.origins.size > 1 },
      origins,
      masking: { mask_all_inputs: Boolean(options.maskAllInputs), passwords: true },
      segments: [],
      tab_events: [],
      markers: [],
      assets: [],
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
      await this.captureExistingAssets(page);
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
    // URL rewriting happens while flushing events. Finish any in-flight static
    // resource copies first so the final snapshot can point at the bundle.
    await Promise.all([...this.assetCaptures.values()]);
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
      this.observeTabEvents(state, payload);
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
      else void this.activateFrame(frame);
    });
    page.on("response", (response) => void this.captureResponse(response));
    void this.activatePage(page);
  }

  private async activatePage(page: Page) {
    if (!this.store || !inScope(page.url(), this.origins)) return;
    this.ensurePageState(page);
    await page.evaluate(invokeRecorder, startConfig(this.store.manifest.masking.mask_all_inputs, this.recordCanvas, this.origins.size > 1)).catch(() => undefined);
  }

  private async activateFrame(frame: Frame) {
    if (!this.store || !inScope(frame.url(), this.origins)) return;
    await frame.evaluate(invokeRecorder, startConfig(this.store.manifest.masking.mask_all_inputs, this.recordCanvas, this.origins.size > 1)).catch(() => undefined);
  }

  private ensurePageState(page: Page) {
    const existing = this.pages.get(page);
    if (existing) return existing;
    const clockOffsetMs = Date.now() - this.startedAt;
    const state: PageState = { id: `seg_${this.pages.size + 1}`, page, queue: [], baseUrl: page.url(), clockOffsetMs };
    this.pages.set(page, state);
    this.store?.segment(state.id, page.url(), clockOffsetMs);
    this.store?.addTabEvent({ type: "opened", segment_id: state.id, t_ms: clockOffsetMs });
    page.on("close", () => {
      this.store?.addTabEvent({ type: "closed", segment_id: state.id, t_ms: Date.now() - this.startedAt });
      void this.flush(state);
    });
    return state;
  }

  private async flush(state: PageState) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
    const events = state.queue.splice(0).map((event) => {
      state.baseUrl = eventUrl(event, state.baseUrl);
      return rewriteAssetUrls(event, state.baseUrl, this.store?.manifest.id, this.store?.manifest.assets ?? [], this.origins);
    });
    if (events.length > 0 && this.store) await this.store.append(state.id, events, Date.now());
  }

  private requireStore() {
    if (!this.store) throw new Error("No recording is active");
    return this.store;
  }

  private observeTabEvents(state: PageState, events: unknown[]) {
    for (const event of events) {
      const timestamp = eventTimestamp(event);
      if (timestamp !== undefined && state.firstEventTimestamp === undefined) state.firstEventTimestamp = timestamp;
      const candidate = event as { type?: number; data?: { tag?: unknown } };
      if (candidate.type !== 5 || candidate.data?.tag !== "rec-tab-focused" || timestamp === undefined || state.firstEventTimestamp === undefined) continue;
      this.store?.addTabEvent({ type: "focused", segment_id: state.id, t_ms: state.clockOffsetMs + Math.max(0, timestamp - state.firstEventTimestamp) });
    }
  }

  private async captureResponse(response: PlaywrightResponse) {
    if (!this.store || !STATIC_RESOURCE_TYPES.has(response.request().resourceType())) return;
    const length = Number(response.headers()["content-length"] ?? 0);
    if (response.status() < 200 || response.status() >= 300 || (length > 0 && length > MAX_ASSET_BYTES)) return;
    const sourceUrl = response.request().url();
    await this.captureAsset(sourceUrl, response.headers()["content-type"] ?? "application/octet-stream", async () => response.body(), response.url());
  }

  private async captureExistingAssets(page: Page) {
    if (!this.store || !inScope(page.url(), this.origins)) return;
    const resources = await page.evaluate(() => {
      const urls = new Set<string>();
      const add = (value: string | null | undefined) => { if (value) { try { urls.add(new URL(value, location.href).href); } catch { /* ignore invalid URLs */ } } };
      document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]').forEach((node) => add(node.href));
      document.querySelectorAll<HTMLElement>("img[src], source[src], video[poster], input[type=image][src]").forEach((node) => add(node.getAttribute("src") ?? node.getAttribute("poster")));
      performance.getEntriesByType("resource").forEach((entry) => {
        const resource = entry as PerformanceResourceTiming;
        if (["img", "css", "link", "font"].includes(resource.initiatorType)) add(resource.name);
      });
      return [...urls];
    }).catch(() => [] as string[]);
    await Promise.all(resources.map((url) => this.captureAssetUrl(url)));
  }

  private async captureAssetUrl(sourceUrl: string) {
    if (!isHttpUrl(sourceUrl)) return;
    const existing = this.assetCaptures.get(sourceUrl);
    if (existing) return existing;
    const capture = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch(sourceUrl, { signal: controller.signal, redirect: "follow" });
          if (!response.ok) return;
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > MAX_ASSET_BYTES) return;
          await this.persistAsset(sourceUrl, new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type") ?? "application/octet-stream", response.url);
        } finally { clearTimeout(timer); }
      } catch { /* A missing protected resource must not prevent a recording. */ }
    })();
    this.assetCaptures.set(sourceUrl, capture);
    return capture;
  }

  private async captureAsset(sourceUrl: string, contentType: string, read: () => Promise<Uint8Array>, alias?: string) {
    if (!this.store || !isHttpUrl(sourceUrl)) return;
    const existing = this.assetCaptures.get(sourceUrl);
    if (existing) return existing;
    const capture = (async () => {
      try {
        const body = await read();
        if (body.byteLength > MAX_ASSET_BYTES || !isStaticContentType(contentType, sourceUrl)) return;
        await this.persistAsset(sourceUrl, body, contentType, alias);
      } catch { /* A missing protected resource must not prevent a recording. */ }
    })();
    this.assetCaptures.set(sourceUrl, capture);
    return capture;
  }

  private async persistAsset(sourceUrl: string, body: Uint8Array, contentType: string, alias?: string) {
    if (!this.store || body.byteLength > MAX_ASSET_BYTES || !isStaticContentType(contentType, sourceUrl)) return;
    const prepared = await this.prepareAssetBody(sourceUrl, body, contentType);
    await this.store.addAsset(sourceUrl, prepared, contentType);
    if (alias && alias !== sourceUrl) await this.store.addAsset(alias, prepared, contentType);
  }

  private async prepareAssetBody(sourceUrl: string, body: Uint8Array, contentType: string) {
    if (!contentType.toLowerCase().includes("css") && !sourceUrl.split("?", 1)[0].endsWith(".css")) return body;
    const css = new TextDecoder().decode(body);
    const children = cssUrls(css, sourceUrl);
    await Promise.all(children.map((url) => this.captureAssetUrl(url)));
    return new TextEncoder().encode(rewriteCssUrls(css, sourceUrl, this.store?.manifest.id, this.store?.manifest.assets ?? []));
  }
}

function originOf(url: string) {
  try { return new URL(url).origin; } catch { return undefined; }
}

function eventTimestamp(event: unknown) {
  if (!event || typeof event !== "object" || !("timestamp" in event)) return undefined;
  const value = Number((event as { timestamp: unknown }).timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function inScope(url: string, origins: Set<string>) {
  const origin = originOf(url);
  return Boolean(origin && origins.has(origin));
}

function startConfig(maskAllInputs: boolean, recordCanvas: boolean, recordCrossOriginIframes: boolean) {
  return { maskAllInputs, recordCanvas, recordCrossOriginIframes };
}
function invokeRecorder(config: { maskAllInputs: boolean; recordCanvas: boolean; recordCrossOriginIframes: boolean }) {
  const api = window as typeof window & { __recStart?: (value: typeof config) => void };
  api.__recStart?.(config);
}

function isHttpUrl(url: string) { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } }
function isStaticContentType(contentType: string, url: string) {
  const value = contentType.toLowerCase();
  return value.includes("text/css") || value.startsWith("image/") || value.startsWith("font/") || value.includes("font") || /\.(?:css|avif|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf)(?:$|[?#])/i.test(url);
}
function eventUrl(event: unknown, fallback: string) {
  const candidate = event as { type?: number; data?: { href?: unknown } };
  return candidate.type === 4 && typeof candidate.data?.href === "string" ? candidate.data.href : fallback;
}
function assetPath(source: string, baseUrl: string, sessionId: string | undefined, assets: { id: string; source_urls: string[] }[]) {
  if (!sessionId) return undefined;
  let absolute: string;
  try { absolute = new URL(source, baseUrl).href; } catch { return undefined; }
  const asset = assets.find((item) => item.source_urls.includes(absolute));
  return asset ? `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(asset.id)}` : undefined;
}
function rewriteCssUrls(value: string, baseUrl: string, sessionId: string | undefined, assets: { id: string; source_urls: string[] }[]) {
  return value.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (whole, quote: string, source: string) => {
    const local = assetPath(source.trim(), baseUrl, sessionId, assets);
    return local ? `url(${quote}${local}${quote})` : whole;
  });
}
function cssUrls(value: string, baseUrl: string) {
  const urls = new Set<string>();
  value.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (_whole, _quote: string, source: string) => {
    try { urls.add(new URL(source.trim(), baseUrl).href); } catch { /* ignore data and malformed URLs */ }
    return _whole;
  });
  return [...urls].filter(isHttpUrl);
}
export function rewriteAssetUrls(event: unknown, baseUrl: string, sessionId: string | undefined, assets: { id: string; source_urls: string[] }[], allowedOrigins: Set<string>): unknown {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      const direct = assetPath(value, baseUrl, sessionId, assets);
      return rewriteCssUrls(direct ?? value, baseUrl, sessionId, assets);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const copy = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
    return iframeFallback(copy, baseUrl, allowedOrigins);
  };
  return rewrite(event);
}

function iframeFallback(value: Record<string, unknown>, baseUrl: string, allowedOrigins: Set<string>) {
  if (value.tagName !== "iframe" || !value.attributes || typeof value.attributes !== "object") return value;
  const attributes = value.attributes as Record<string, unknown>;
  if (typeof attributes.src !== "string") return value;
  let source: URL;
  try { source = new URL(attributes.src, baseUrl); } catch { return value; }
  if (allowedOrigins.has(source.origin)) return value;
  const label = escapeIframeText(source.host || source.href);
  return { ...value, attributes: { ...attributes, src: "about:blank", srcdoc: `<body style="margin:0;display:grid;place-items:center;background:#f4f4f7;color:#4b4b58;font:14px system-ui"><div style="max-width:260px;padding:24px;text-align:center"><strong>External frame unavailable</strong><p style="margin:8px 0 0">${label} was not included in this recording.</p></div></body>`, "data-rec-frame-fallback": "external" } };
}
function escapeIframeText(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }

async function recorderScript() {
  // The package exports only its module entrypoint. Resolve that supported path
  // first, then select the adjacent browser-safe UMD bundle.
  const path = join(dirname(require.resolve("@rrweb/record")), "record.umd.min.cjs");
  const rrweb = await readFile(path, "utf8");
  return `${rrweb}\n;(() => {
    let stop; let stopTabFocus; let buffer = []; let timer;
    const rrwebRecord = window.rrweb || window.rrwebRecord;
    const flush = () => { if (buffer.length) window.__rec_emit(buffer.splice(0)); if (timer) { clearTimeout(timer); timer = undefined; } };
    window.__recStart = ({ maskAllInputs, recordCanvas, recordCrossOriginIframes }) => {
      if (stop || !rrwebRecord) return;
      stop = rrwebRecord.record({
        emit(event) { buffer.push(event); if (buffer.length >= 200) flush(); else if (!timer) timer = setTimeout(flush, ${FLUSH_MS}); },
        checkoutEveryNms: 60000,
        inlineStylesheet: true,
        collectFonts: true,
        recordCanvas,
        recordCrossOriginIframes,
        // We immediately replace unscoped cross-origin frames with a visible
        // replay placeholder before persisting events. Keeping src here lets us
        // retain the source host for that explanation.
        keepIframeSrcFn: () => true,
        slimDOM: true,
        maskAllInputs,
        maskInputOptions: { password: true },
        sampling: { mousemove: 50, scroll: 150 },
      });
      if (window.top === window) {
        const reportFocus = () => { if (document.visibilityState === "visible") rrwebRecord.record.addCustomEvent("rec-tab-focused", {}); };
        document.addEventListener("visibilitychange", reportFocus);
        stopTabFocus = () => document.removeEventListener("visibilitychange", reportFocus);
        reportFocus();
      }
    };
    window.__recAddMarker = (label, note) => rrwebRecord?.record?.addCustomEvent?.("rec-marker", { label, note });
    window.__recStop = () => { flush(); stopTabFocus?.(); stopTabFocus = undefined; stop?.(); stop = undefined; };
  })();`;
}
