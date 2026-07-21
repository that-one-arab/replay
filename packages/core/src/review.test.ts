import assert from "node:assert/strict";
import test from "node:test";
import { assessReplay, authPageFinding, isAuthPage } from "./review.js";
import type { AgentAction, Marker, ReplayManifest } from "./types.js";

function manifest(overrides: Partial<ReplayManifest> = {}): ReplayManifest {
  return {
    format_version: 1,
    id: "replay_test",
    title: "Test replay",
    created_at: "2026-01-01T00:00:00.000Z",
    capture: { version: "0.1.0", rrweb: "2.0.0-alpha.20", capture_canvas: false, capture_cross_origin_iframes: false },
    origins: ["https://app.example.com"],
    masking: { mask_all_inputs: false, passwords: true },
    segments: [{ id: "seg_1", page_url: "https://app.example.com/dashboard", clock_offset_ms: 0, chunks: [] }],
    tab_events: [],
    markers: [],
    assets: [],
    ...overrides,
  };
}

function action(tool: string, startedAtMs: number): AgentAction {
  return { id: `act_${startedAtMs}`, tool, started_at_ms: startedAtMs, finished_at_ms: startedAtMs + 10, ok: true };
}

function defectHighlight(tMs: number, nodeId = 7): Marker {
  return { t_ms: tMs, label: "Defect", defect: { expected: "Step 2 of 3", actual: "1 of 3 completed" }, node_id: nodeId };
}

const codes = (findings: ReturnType<typeof assessReplay>) => findings.map((finding) => finding.code);

test("a clean reproduction with a resolved defect highlight produces no findings", () => {
  const findings = assessReplay(manifest({ outcome: "reproduced", markers: [defectHighlight(1_000)] }));
  assert.deepEqual(findings, []);
});

test("flags when the replay opens on an auth or setup screen", () => {
  const findings = assessReplay(manifest({ outcome: "reproduced", markers: [defectHighlight(1_000)], segments: [{ id: "seg_1", page_url: "https://app.example.com/en/login", clock_offset_ms: 0, chunks: [] }] }));
  assert.deepEqual(codes(findings), ["opens_on_auth_page"]);
  assert.equal(findings[0]!.severity, "warn");
});

test("flags a missing resolved defect highlight and escalates to an error for a reproduction", () => {
  // A defect without a resolved node still leaves the viewer with no ring.
  const unresolved = assessReplay(manifest({ outcome: "reproduced", markers: [{ t_ms: 1_000, label: "Defect", defect: { expected: "x", actual: "y" } }] }));
  assert.deepEqual(codes(unresolved), ["no_resolved_defect_highlight"]);
  assert.equal(unresolved[0]!.severity, "error");

  // A node without a defect claim is not a defect highlight either.
  const noDefect = assessReplay(manifest({ markers: [{ t_ms: 1_000, label: "Pin", node_id: 3 }] }));
  assert.deepEqual(codes(noDefect), ["no_resolved_defect_highlight"]);
  assert.equal(noDefect[0]!.severity, "warn", "without an outcome the finding stays a warning");

  // A markerless clean flow is not flagged as discovery noise.
  assert.deepEqual(codes(assessReplay(manifest())), ["no_resolved_defect_highlight"]);
});

test("flags discovery actions that occur after the final marker", () => {
  const findings = assessReplay(manifest({
    markers: [{ t_ms: 1_000, label: "Submitted" }, defectHighlight(1_500)],
    actions: [action("browser_find", 2_000), action("browser_take_screenshot", 3_000), action("browser_network_requests", 4_000)],
  }));
  assert.deepEqual(codes(findings), ["discovery_noise_after_last_marker"]);

  // Inspection before the final marker is part of the deliberate flow, not noise.
  const before = assessReplay(manifest({
    markers: [defectHighlight(5_000)],
    actions: [action("browser_find", 1_000), action("browser_take_screenshot", 2_000)],
  }));
  assert.deepEqual(before, []);

  // With no markers at all, a clean markerless flow is not flagged.
  const markerless = assessReplay(manifest({ actions: [action("browser_click", 1_000), action("browser_find", 2_000)] }));
  assert.deepEqual(codes(markerless), ["no_resolved_defect_highlight"]);
});

test("the real SHIP replay shape (login page, markerless defect, post-marker hunting) hits all three", () => {
  const findings = assessReplay(manifest({
    outcome: "reproduced",
    segments: [{ id: "seg_1", page_url: "https://dev-new.signit.sa/en/login", clock_offset_ms: 0, chunks: [] }],
    markers: [
      { t_ms: 188_789, label: "Enter duplicate phone number", action_id: "act_a" },
      { t_ms: 224_170, label: "Reload draft with duplicate phones", action_id: "act_b" },
    ],
    actions: [
      action("browser_find", 199_083),
      action("browser_find", 228_708),
      action("browser_take_screenshot", 235_700),
      action("browser_network_requests", 236_308),
    ],
  }));
  assert.deepEqual(codes(findings), ["opens_on_auth_page", "no_resolved_defect_highlight", "discovery_noise_after_last_marker"]);
  assert.equal(findings.find((finding) => finding.code === "no_resolved_defect_highlight")!.severity, "error");
});

test("isAuthPage and authPageFinding classify auth and setup URLs", () => {
  for (const url of [
    "https://app.example.com/login",
    "https://app.example.com/en/signin",
    "https://app.example.com/auth",
    "https://app.example.com/onboarding",
    "https://app.example.com/setup",
    "https://app.example.com/reset-password",
  ]) {
    assert.equal(isAuthPage(url), true, url);
    assert.equal(authPageFinding(url)?.code, "opens_on_auth_page", url);
  }
  for (const url of [
    "https://app.example.com/dashboard",
    "https://app.example.com/projects/123",
    "https://app.example.com/",
    "about:blank",
    "not a url",
  ]) {
    assert.equal(isAuthPage(url), false, url);
    assert.equal(authPageFinding(url), null, url);
  }
});
