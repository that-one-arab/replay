import { Replayer } from "@rrweb/replay";
import "./style.css";

type Marker = { t_ms: number; label: string; note?: string };
type Manifest = {
  id: string; title: string; outcome?: string; created_at: string; raw_duration_ms?: number; active_duration_ms?: number;
  markers: Marker[]; segments: { id: string; page_url: string }[];
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const id = new URLSearchParams(location.search).get("id");
if (!id) renderError("Choose a recording with `rec open <id>`.");
else void load(id);

async function load(recordingId: string) {
  try {
    const manifest = await request<Manifest>(`/api/sessions/${encodeURIComponent(recordingId)}/manifest`);
    renderShell(manifest);
    await replay(manifest, manifest.segments[0]?.id);
  } catch (error) { renderError(error instanceof Error ? error.message : String(error)); }
}

function renderShell(manifest: Manifest) {
  app.innerHTML = `<section class="topbar"><div><p class="eyebrow">LOCAL SESSION REPLAY</p><h1>${escape(manifest.title)}</h1><p class="meta">${escape(manifest.outcome ?? "recorded")} · ${format(manifest.active_duration_ms)} active of ${format(manifest.raw_duration_ms)} wall clock</p></div><div class="badge">idle skipped</div></section>
  <section class="layout"><aside><h2>Segments</h2><div class="segments">${manifest.segments.map((segment, index) => `<button data-segment="${escape(segment.id)}" class="${index === 0 ? "selected" : ""}">${index + 1}. ${escape(new URL(segment.page_url).pathname || "/")}</button>`).join("")}</div><h2>Markers</h2><ol class="markers">${manifest.markers.length ? manifest.markers.map((marker, index) => `<li><button data-marker="${marker.t_ms}"><span>${format(marker.t_ms)}</span>${escape(marker.label)}${marker.note ? `<small>${escape(marker.note)}</small>` : ""}</button></li>`).join("") : "<li class=empty>No markers added</li>"}</ol></aside><section class="viewer"><div class="controls"><button id="play">Play</button><button id="pause">Pause</button><button id="skip">Skip idle: on</button><label>Speed <select id="speed"><option>1</option><option>2</option><option>4</option><option>8</option><option>16</option></select>×</label></div><div id="replay"></div></section></section>`;
}

async function replay(manifest: Manifest, segmentId: string | undefined) {
  if (!segmentId) return;
  const events = await request<object[]>(`/api/sessions/${encodeURIComponent(manifest.id)}/events?segment=${encodeURIComponent(segmentId)}`);
  const mount = document.querySelector<HTMLDivElement>("#replay")!;
  mount.replaceChildren();
  const replayer = new Replayer(events as never[], { root: mount, skipInactive: true, showWarning: false });
  document.querySelector<HTMLButtonElement>("#play")!.onclick = () => replayer.play();
  document.querySelector<HTMLButtonElement>("#pause")!.onclick = () => replayer.pause();
  document.querySelector<HTMLButtonElement>("#skip")!.onclick = () => { replayer.setConfig({ skipInactive: !replayer.config.skipInactive }); const button = document.querySelector<HTMLButtonElement>("#skip")!; button.textContent = `Skip idle: ${replayer.config.skipInactive ? "on" : "off"}`; };
  document.querySelector<HTMLSelectElement>("#speed")!.onchange = (event) => replayer.setConfig({ speed: Number((event.target as HTMLSelectElement).value) });
  document.querySelectorAll<HTMLButtonElement>("[data-marker]").forEach((button) => { button.onclick = () => replayer.play(button.dataset.marker ? Number(button.dataset.marker) : 0); });
  document.querySelectorAll<HTMLButtonElement>("[data-segment]").forEach((button) => { button.onclick = () => { document.querySelector(".selected")?.classList.remove("selected"); button.classList.add("selected"); void replay(manifest, button.dataset.segment); }; });
}

async function request<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error);
  return response.json() as Promise<T>;
}

function format(ms?: number) { if (!ms) return "0s"; const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; }
function escape(value: string) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }
function renderError(message: string) { app.innerHTML = `<section class=error><p class=eyebrow>REC</p><h1>Replay unavailable</h1><p>${escape(message)}</p></section>`; }
