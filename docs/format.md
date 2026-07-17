# Recording bundle format (v1 spike)

Each session is a self-contained directory:

```text
manifest.json
events/<segment-id>-<sequence>.jsonl.gz
markers.json
```

Every gzipped JSONL entry contains the source segment, its daemon receipt time, and
the original rrweb event. Chunks are independently valid gzip streams, so a crash
can only lose the current 500 ms in-memory batch. `manifest.json` is written on
start and atomically replaced on stop with final durations and chunks.

The format is local only in this spike. Future server uploads should send the
manifest and chunks unchanged.
