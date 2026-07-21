import type { AgentAction, Marker, ReplayManifest, ReviewFinding } from "./types.js";

// Auth/setup screens are discovery territory. A reproduced-bug replay should
// open on the feature, not the login flow that got the agent there.
const AUTH_PATH =
  /(^|[_/-])(login|signin|sign-in|signup|sign-up|authenticate|onboard|onboarding|setup|install|forgot|reset)([_/-]|$)/i;

/** True when a URL's path looks like an authentication or initial-setup screen. */
export function isAuthPage(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (!path || path === "/") return false;
  return AUTH_PATH.test(path);
}

/** The auth-start finding for a single URL, or null when the URL is not auth-like. */
export function authPageFinding(url: string): ReviewFinding | null {
  if (!isAuthPage(url)) return null;
  return {
    code: "opens_on_auth_page",
    severity: "warn",
    message: `Capture started on an auth/setup screen (${url}).`,
    hint: "A reproduced-bug replay should open on the feature, not the login. Discover the repro first without capturing, then re-record a performance pass that starts from the feature page.",
  };
}

function hasResolvedDefectHighlight(markers: Marker[]): boolean {
  return markers.some((marker) => marker.defect != null && marker.node_id != null);
}

// Inspection and debugging tools. Appearing after the agent has already marked a
// checkpoint reads as continued discovery — hunting for the bug inside the
// recording rather than performing a known reproduction.
const DISCOVERY_TOOLS = new Set([
  "browser_find",
  "browser_take_screenshot",
  "browser_network_requests",
  "browser_network_request",
]);

function discoveryNoiseAfterLastMarker(markers: Marker[], actions: AgentAction[]): ReviewFinding | null {
  const lastMarkerT = markers.reduce((max, marker) => Math.max(max, marker.t_ms), -1);
  if (lastMarkerT < 0) return null;
  const noisy = actions.filter((action) => action.started_at_ms > lastMarkerT && DISCOVERY_TOOLS.has(action.tool));
  if (noisy.length === 0) return null;
  const tools = [...new Set(noisy.map((action) => action.tool))].join(", ");
  return {
    code: "discovery_noise_after_last_marker",
    severity: "warn",
    message: `After the final marker the capture still contains discovery actions (${tools}).`,
    hint: "The performance pass should contain only deliberate steps. If you searched for or screenshotted the bug mid-capture, re-navigate to the start and re-record the whole pass rather than narrating over it.",
  };
}

/**
 * Deterministic replay-quality assessment from a manifest alone — no event reload,
 * no browser. Used at capture stop (before finalize) and by the replay_review tool.
 * Pass the intended `outcome` to escalate the defect-highlight finding for a
 * reproduction; before stop the manifest carries no outcome yet.
 */
export function assessReplay(manifest: ReplayManifest, outcome?: ReplayManifest["outcome"]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const startUrl = manifest.segments[0]?.page_url;
  if (startUrl) {
    const finding = authPageFinding(startUrl);
    if (finding) findings.push(finding);
  }
  const effectiveOutcome = outcome ?? manifest.outcome;
  if (!hasResolvedDefectHighlight(manifest.markers)) {
    findings.push({
      code: "no_resolved_defect_highlight",
      severity: effectiveOutcome === "reproduced" ? "error" : "warn",
      message: "No defect highlight resolved to an element on the page.",
      hint: "At the decisive moment call capture_highlight with { element: { text }, defect: { expected, actual } }. The element must resolve (node_id non-null) so the viewer sees the ring and the expected-vs-actual callout.",
    });
  }
  const noise = discoveryNoiseAfterLastMarker(manifest.markers, manifest.actions ?? []);
  if (noise) findings.push(noise);
  return findings;
}
