/** Small pure formatting and math helpers shared across the player. */

export function format(ms?: number) { if (!ms) return "0:00"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
export function formatDuration(ms: number) { return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`; }
export function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
export function nearlyEqual(left: number, right: number) { return Math.abs(left - right) < 2; }
// The player builds markup with template literals that interpolate into
// attribute values too, so quotes must be neutralized along with the
// element-context characters.
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escape(value: string) { return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!); }
