# Recording bundle format (v1 spike)

Each session is a self-contained directory:

```text
manifest.json
events/<segment-id>-<sequence>.jsonl.gz
assets/<sha256>
markers.json
```

Each segment is one browser tab’s rrweb event stream. Its `clock_offset_ms` aligns
that tab with the browser-session timeline, allowing the player to show multiple
tabs as one recording without trying to merge incompatible DOM trees. A tab becomes
visible when its `opened` lifecycle event is reached and receives playback focus
only when its `focused` lifecycle event is reached. `closed` events remove tabs that
were closed before the recording ended.

Every gzipped JSONL entry contains the source segment, its daemon receipt time, and
the original rrweb event. Chunks are independently valid gzip streams, so a crash
can only lose the current 500 ms in-memory batch. Captured static resources are
content-addressed under `assets/`; persisted replay events point to the local asset
endpoint. `manifest.json` is written on start and atomically replaced on stop with
final durations, chunks, tab metadata, and assets.

Top-level document transitions are stored in `manifest.json` as
`navigation_events`. Each completed event records its segment, best-effort kind
(`reload` or `navigate`), request start, document commit, ready timestamps, and
source/destination URLs. The player uses this durable metadata for refresh and
navigation transitions, so seeking does not mistake rrweb's historical document
rebuild for a new refresh.

The format is local only in this spike. Future server uploads should send the
manifest and chunks unchanged. Markers have a timestamp, label, optional note, and
optional `placement`: `after_previous` (the default) describes a confirmed result
after the previous agent action, while `before_next` describes a precondition or
chapter boundary. Placement is narrative ordered metadata, not a browser-action ID.
