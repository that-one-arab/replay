/**
 * Synthetic cursor presentation for replays without pointer coordinates:
 * placing and revealing rrweb's cursor element, and the click ripple drawn at
 * each interaction point.
 */
import type { Replayer } from "@rrweb/replay";
import { isRealPoint } from "./humanize.js";

export type ElementLike = { nodeType: number; classList: DOMTokenList; getAttribute(name: string): string | null; textContent: string | null; tagName: string; getBoundingClientRect(): DOMRect };
export function isElementLike(value: unknown): value is ElementLike { return typeof value === "object" && value !== null && (value as { nodeType?: number }).nodeType === 1 && "classList" in value; }

/** Center of the element an interaction resolved to, in the replay's content
 *  coordinates (which the cursor overlay shares); undefined if it isn't laid out. */
export function elementCenter(node: unknown): { x: number; y: number } | undefined {
  if (!isElementLike(node)) return undefined;
  const rect = node.getBoundingClientRect();
  if (!rect.width && !rect.height) return undefined;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Move the synthetic cursor. `durationMs` glides it (a lead-in approach); 0
 * snaps instantly (the exact landing at interaction time, re-asserted after
 * rrweb re-parks the cursor at (0,0) on click). The first appearance always
 * lands on target rather than gliding in from the page corner.
 */
export function makeCursorPlacer(replayer: Replayer) {
  let placed = false;
  return (x: number, y: number, durationMs: number) => {
    const mouse = replayer.wrapper.querySelector<HTMLElement>(".replayer-mouse");
    if (!mouse) return;
    const duration = placed ? durationMs : 0;
    mouse.style.transition = duration > 0
      ? `left ${duration}ms cubic-bezier(.22, .61, .36, 1), top ${duration}ms cubic-bezier(.22, .61, .36, 1), opacity .25s ease`
      : "opacity .25s ease";
    mouse.style.left = `${x}px`;
    mouse.style.top = `${y}px`;
    placed = true;
    replayer.wrapper.classList.add("replay-cursor-live");
  };
}

export function revealCursorOnFirstMove(replayer: Replayer, lifetime: AbortController) {
  const mouse = replayer.wrapper.querySelector<HTMLElement>(".replayer-mouse");
  if (!mouse) return;
  // rrweb parks the cursor at the page origin until the first pointer event
  // positions it. Keep it invisible until it actually lands somewhere real —
  // replays whose only "positions" are origin clicks never reveal a cursor
  // stranded in the top-left corner.
  const reveal = new MutationObserver(() => {
    const x = parseFloat(mouse.style.left);
    const y = parseFloat(mouse.style.top);
    if (!isRealPoint(x, y)) return;
    replayer.wrapper.classList.add("replay-cursor-live");
    reveal.disconnect();
  });
  reveal.observe(mouse, { attributes: true, attributeFilter: ["style"] });
  lifetime.signal.addEventListener("abort", () => reveal.disconnect(), { once: true });
}

export function spawnClickRipple(replayer: Replayer, interaction: { x?: number; y?: number }) {
  const mouse = replayer.wrapper.querySelector<HTMLElement>(".replayer-mouse");
  const x = typeof interaction.x === "number" ? interaction.x : parseFloat(mouse?.style.left ?? "");
  const y = typeof interaction.y === "number" ? interaction.y : parseFloat(mouse?.style.top ?? "");
  if (!isRealPoint(x, y)) return;
  const ripple = document.createElement("span");
  ripple.className = "replay-click-ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  replayer.wrapper.appendChild(ripple);
  window.setTimeout(() => ripple.remove(), 700);
}
