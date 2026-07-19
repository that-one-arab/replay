import type { ReplayEvent } from "./types.js";

// The recorder rewrites captured static resources to same-origin
// `/api/sessions/.../assets/...` paths so a shared replay is self-contained. Any
// resource it could not capture (uncaptured media, oversized files, protected or
// failed fetches, a capture that lost the flush race) keeps its original absolute
// URL — usually the recorded dev origin, e.g. http://127.0.0.1:5173. When rrweb
// remounts that DOM on the public sharing origin, the browser tries to fetch it,
// and Chrome gates the public→private request behind its "local network access"
// prompt. This pass is the belt-and-braces guarantee: it neutralizes every
// resource attribute that still holds a fetchable absolute URL, so a missed asset
// degrades to a blank image instead of a permission prompt (or a data leak back
// to the recorder's machine).

// 1x1 transparent GIF — swapped in for image-like resources so they render as
// nothing rather than a broken-image glyph.
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// Attributes whose value the browser fetches as a subresource. `href` and
// `xlink:href` are handled separately because they only fetch on a few tags
// (a plain <a href> is navigation, not a fetch, and must be left intact).
const FETCHED_SRC_ATTRS = new Set(["src", "poster"]);
// Tags where an href/xlink:href triggers a subresource fetch during replay.
const HREF_FETCH_TAGS = new Set(["link", "image", "use"]);
// Tags whose neutralized resource should fall back to a blank image rather than
// about:blank, to avoid a broken-image placeholder.
const IMAGE_LIKE_TAGS = new Set(["img", "image", "input", "source", "use", "video"]);

/** A URL that, resolved on the sharing origin, would issue a cross/absolute fetch. */
export function isFetchableAbsolute(value: string): boolean {
  const url = value.trim();
  if (!url || url.startsWith("#")) return false;
  if (/^(?:data|blob|about|javascript):/i.test(url)) return false;
  // scheme://host, or protocol-relative //host — anything with an authority.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("//");
}

function blankUrlForTag(tag: string | undefined): string {
  return tag && IMAGE_LIKE_TAGS.has(tag) ? BLANK_IMAGE : "about:blank";
}

// An @font-face src that lost all of its captured candidates must resolve to
// nothing without fetching: a local() lookup that cannot match misses silently,
// so the text falls back down the font stack with zero network or decode work.
const UNCAPTURED_FONT_SRC = 'local("rec-uncaptured-font")';

// Split a font-face src list on top-level commas only — url(data:...;base64,...)
// bodies contain commas that must not break a candidate apart.
function splitFontSrcCandidates(value: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      candidates.push(value.slice(start, index));
      start = index + 1;
    }
  }
  candidates.push(value.slice(start));
  return candidates.map((candidate) => candidate.trim()).filter(Boolean);
}

// @font-face sources must never be swapped for the blank image: the browser
// downloads whatever url() the src names and tries to decode it as a font, so a
// GIF placeholder yields an OTS parsing error — re-triggered on every stylesheet
// re-application until the flood hangs the replay. Drop uncaptured candidates
// from the src list instead.
function blankFontFaceSources(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, (block) =>
    block.replace(/src\s*:\s*([^;}]+)/gi, (whole, value: string) => {
      const kept = splitFontSrcCandidates(value).filter((candidate) => {
        const url = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(candidate);
        return !url || !isFetchableAbsolute(url[2]);
      });
      const next = kept.join(", ") || UNCAPTURED_FONT_SRC;
      return next === value.trim() ? whole : `src: ${next}`;
    }));
}

// Rewrite absolute url(...) and @import targets inside a CSS string. rrweb inlines
// stylesheets (as `_cssText` attributes and <style> text), so their background
// images, fonts and imports leak the recorded origin just like element sources.
function blankCssUrls(css: string): string {
  // Drop absolute @imports first: the generic url() pass below would otherwise
  // rewrite an `@import url(http://...)` into `@import url(data:...)`, leaving a
  // live (if now harmless) import in place. Handles both url() and string forms.
  // Font-face sources go next, before the url() pass can hand a font slot the
  // blank image — after that pass no absolute URL remains inside those blocks.
  return blankFontFaceSources(css
    .replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")]+)\1\s*\)?\s*;?/gi, (whole, _quote: string, inner: string) =>
      isFetchableAbsolute(inner) ? "" : whole))
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote: string, inner: string) =>
      isFetchableAbsolute(inner) ? `url(${BLANK_IMAGE})` : whole);
}

function blankSrcset(value: string): string {
  const safe = value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .filter((candidate) => !isFetchableAbsolute(candidate.split(/\s+/)[0]));
  return safe.join(", ");
}

function sanitizeAttributeValue(key: string, value: unknown, tag: string | undefined): unknown {
  if (typeof value !== "string") return value;
  const lower = key.toLowerCase();
  if (lower === "srcset" || lower === "imagesrcset") return blankSrcset(value);
  if (lower === "style" || lower === "_csstext") return blankCssUrls(value);
  if (!isFetchableAbsolute(value)) return value;
  if (FETCHED_SRC_ATTRS.has(lower)) return blankUrlForTag(tag);
  if ((lower === "href" || lower === "xlink:href") && tag && HREF_FETCH_TAGS.has(tag)) return blankUrlForTag(tag);
  if (lower === "data" && tag === "object") return "about:blank";
  return value;
}

function sanitizeAttributes(attributes: Record<string, unknown>, tag: string | undefined): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const next = sanitizeAttributeValue(key, value, tag);
    out[key] = next;
    if (next !== value) changed = true;
  }
  return changed ? out : attributes;
}

// A serialized rrweb DOM node: element nodes carry `tagName`/`attributes`, and a
// <style> element's CSS lives in the `textContent` of its child text node.
function sanitizeNode(node: unknown, parentTag?: string): unknown {
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const tag = typeof record.tagName === "string" ? record.tagName.toLowerCase() : undefined;

  if (parentTag === "style" && typeof record.textContent === "string") {
    const textContent = blankCssUrls(record.textContent);
    return textContent === record.textContent ? node : { ...record, textContent };
  }

  let attributes = record.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    attributes = sanitizeAttributes(attributes as Record<string, unknown>, tag);
  }
  let childNodes = record.childNodes;
  if (Array.isArray(childNodes)) {
    const mapped = childNodes.map((child) => sanitizeNode(child, tag));
    childNodes = mapped.some((child, index) => child !== (record.childNodes as unknown[])[index]) ? mapped : childNodes;
  }

  if (attributes === record.attributes && childNodes === record.childNodes) return node;
  return { ...record, attributes, childNodes };
}

// Attribute-mutation entries (rrweb incremental type 3) carry no tag context, so
// only unambiguous resource attributes are neutralized; href stays untouched here
// because it could be an anchor. The initial full snapshot, which does have tag
// context, covers the overwhelmingly common case.
function sanitizeAttributeMutation(mutation: unknown): unknown {
  if (!mutation || typeof mutation !== "object") return mutation;
  const record = mutation as Record<string, unknown>;
  const attributes = record.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return mutation;
  const sanitized = sanitizeAttributes(attributes as Record<string, unknown>, undefined);
  return sanitized === attributes ? mutation : { ...record, attributes: sanitized };
}

function sanitizeEvent(event: ReplayEvent): ReplayEvent {
  if (!event || typeof event !== "object") return event;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return event;
  const record = data as Record<string, unknown>;

  // Full snapshot (type 2): the whole serialized document lives under `node`.
  if (event.type === 2 && record.node) {
    const node = sanitizeNode(record.node);
    return node === record.node ? event : { ...event, data: { ...record, node } } as ReplayEvent;
  }

  // Incremental mutations (type 3): added subtrees plus attribute changes.
  if (event.type === 3) {
    let next = record;
    if (Array.isArray(record.adds)) {
      const adds = record.adds.map((add) => {
        if (!add || typeof add !== "object" || !("node" in add)) return add;
        const entry = add as Record<string, unknown>;
        const node = sanitizeNode(entry.node);
        return node === entry.node ? add : { ...entry, node };
      });
      if (adds.some((add, index) => add !== (record.adds as unknown[])[index])) next = { ...next, adds };
    }
    if (Array.isArray(record.attributes)) {
      const attributes = record.attributes.map(sanitizeAttributeMutation);
      if (attributes.some((entry, index) => entry !== (record.attributes as unknown[])[index])) next = { ...next, attributes };
    }
    return next === record ? event : { ...event, data: next } as ReplayEvent;
  }

  return event;
}

/** Neutralize every replay resource URL that would fetch from an absolute origin. */
export function sanitizeReplayEvents(events: ReplayEvent[]): ReplayEvent[] {
  return events.map(sanitizeEvent);
}
