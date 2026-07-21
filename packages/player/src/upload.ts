import { escape } from "./format.js";

// The hosted share server accepts a raw `.replay` body on this endpoint and
// hands back the share link to redirect to. Uploads cross the public internet
// and can be large, so give them a generous leash before treating a stall as
// a failure.
const UPLOAD_ENDPOINT = "/v1/replays";
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type ShareHandoff = { shareUrl?: string };

// Render the "drop a replay here" landing shown at the bare origin of the
// hosted share server (share.replaythis.io). Selecting or dropping a `.replay`
// uploads it and redirects to its share link — the same link a local Share
// would have produced.
export function renderUploadDialog() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  app.innerHTML = `<section class="upload-screen">
    <div class="upload-card">
      <span class="upload-kicker"><i></i>Replay</span>
      <h1>Upload a replay</h1>
      <p class="upload-lead">Drop a <code>.replay</code> file to watch it here and get a shareable link.</p>
      <button class="upload-drop" id="upload-drop" type="button" aria-label="Choose a .replay file to upload">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <strong>Drop a <code>.replay</code> here</strong>
        <span>or click to browse</span>
      </button>
      <p class="upload-status" id="upload-status" role="status" aria-live="polite" hidden></p>
      <p class="upload-hint">Create one with <code>replay export &lt;id&gt;</code>, or Download from any replay.</p>
    </div>
    <input id="upload-input" type="file" accept=".replay" hidden />
  </section>`;
  wireUpload(app);
}

function wireUpload(app: HTMLElement) {
  const drop = app.querySelector<HTMLButtonElement>("#upload-drop")!;
  const input = app.querySelector<HTMLInputElement>("#upload-input")!;
  let busy = false;
  const pick = (file: File | undefined | null) => { if (file && !busy) void beginUpload(file); };
  drop.onclick = () => { if (!busy) input.click(); };
  input.onchange = () => pick(input.files?.[0]);
  // Drag-and-drop onto the whole card, not just the button, so an imprecise
  // drop still lands. preventDefault on dragover is what lets the drop fire.
  for (const event of ["dragenter", "dragover"] as const) {
    drop.addEventListener(event, (e) => { e.preventDefault(); if (!busy) drop.classList.add("is-dragging"); });
  }
  for (const event of ["dragleave", "dragend"] as const) {
    drop.addEventListener(event, () => drop.classList.remove("is-dragging"));
  }
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-dragging");
    pick(e.dataTransfer?.files?.[0]);
  });

  async function beginUpload(file: File) {
    if (!file.name.toLowerCase().endsWith(".replay")) return void setStatus("error", "That is not a .replay file. Export one with `replay export <id>`.");
    if (file.size > MAX_UPLOAD_BYTES) return void setStatus("error", `That replay is larger than the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`);
    busy = true;
    drop.classList.add("is-busy");
    setStatus("busy", `Uploading ${file.name}…`);
    try {
      const response = await fetch(UPLOAD_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/vnd.replay" },
        body: file,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const result = await response.json().catch(() => ({})) as ShareHandoff & { error?: string };
      if (!response.ok) throw new Error(result.error || `The server rejected the upload (${response.status}).`);
      if (!result.shareUrl) throw new Error("The upload succeeded but no share link came back.");
      // Land the viewer on the freshly minted link (which redirects into the
      // player for this replay) rather than reloading the dialog.
      setStatus("busy", "Opening replay…");
      window.location.href = result.shareUrl;
    } catch (error) {
      busy = false;
      drop.classList.remove("is-busy");
      const message = error instanceof DOMException && error.name === "TimeoutError"
        ? "The upload took too long. Check your connection and try again."
        : error instanceof Error ? error.message : String(error);
      setStatus("error", message);
    }
  }

  function setStatus(kind: "busy" | "error", message: string) {
    const status = app.querySelector<HTMLElement>("#upload-status")!;
    status.hidden = false;
    status.className = `upload-status is-${kind}`;
    status.innerHTML = kind === "busy" ? `<span class="upload-spinner" aria-hidden="true"></span>${escape(message)}` : escape(message);
  }
}
