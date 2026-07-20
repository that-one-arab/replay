# Replay bundle format (v1)

Each session is a self-contained directory:

```text
manifest.json
events/<segment-id>-<sequence>.jsonl.gz
assets/<sha256>
markers.json
```

Each segment is one browser tab’s rrweb event stream. Its `clock_offset_ms` aligns
that tab with the browser-session timeline, allowing the player to show multiple
tabs as one replay without trying to merge incompatible DOM trees. A tab becomes
visible when its `opened` lifecycle event is reached and receives playback focus
only when its `focused` lifecycle event is reached. `closed` events remove tabs that
were closed before the replay ended.

Every gzipped JSONL entry contains the source segment, its daemon receipt time, and
the original rrweb event. Chunks are independently valid gzip streams, so a crash
can only lose the current 500 ms in-memory batch. Captured static resources are
content-addressed under `assets/`; persisted replay events point to the local asset
endpoint. `manifest.json` is written on start and atomically replaced on stop with
final durations, chunks, tab metadata, and assets.

Top-level document transitions are stored in `manifest.json` as
`navigation_events`. Each completed event captures its segment, best-effort kind
(`reload` or `navigate`), request start, document commit, ready timestamps, and
source/destination URLs. The player uses this durable metadata for refresh and
navigation transitions, so seeking does not mistake rrweb's historical document
rebuild for a new refresh.

Browser tool calls the agent issued while capturing are stored in
`manifest.json` as `actions`. Each action captures its ID, tool name, a compact
argument summary, its request/response bracket (`started_at_ms`,
`finished_at_ms` relative to replay start), and whether it succeeded.

Markers have a timestamp, label, optional note, and either an `action_id` or an
optional `placement`. A marker created through a browser tool's `replay_marker`
parameter carries the `action_id` of the action it was captured atomically
with; the player anchors it on that action's bracket deterministically.
Standalone markers use `placement` instead: `after_previous` (the default)
describes a confirmed result after the previous agent action, while
`before_next` describes a precondition or chapter boundary. Placement is
narrative ordered metadata, not a browser-action ID.

## Portable `.replay` artifact (v1)

`replay export <session-id>` writes a gzip-compressed JSON artifact containing the
session manifest and every referenced event chunk and captured asset. Each file
has a SHA-256 checksum; import verifies the manifest checksum, file set, paths,
sizes, and file checksums before making any local changes. These checks detect
accidental corruption, not a signed or authenticated sender.

`replay import <file.replay>` atomically installs a verified artifact into the local
spool, refusing to overwrite an existing replay ID. The normal local viewer
then replays it with `replay open <session-id>`. That means a recipient needs Replay,
but does not need the original computer, browser, replay directory, or daemon
state. The artifact carries the stored replay data; normal replay limitations
for resources that were never captured still apply.
