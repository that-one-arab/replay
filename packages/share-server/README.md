# `@replay/share-server`

The hosted replay service used by the Railway prototype. It accepts a validated
portable `.replay` artifact, imports it into its private spool, and serves the
existing player through an opaque bearer link.

Required deployment settings:

```text
REPLAY_SHARE_DATA_DIR=/data
REPLAY_SHARE_PUBLIC_URL=https://<your-service-domain>
REPLAY_SHARE_MAX_UPLOAD_BYTES=52428800
```

Use persistent storage for `REPLAY_SHARE_DATA_DIR`; without it, uploads disappear on
redeploy. This package intentionally provides unlisted bearer links only. Access
control, retention, expiry, revocation, and auditability are later work.

## Telemetry

The server writes one structured JSON log line per request to stdout (method,
path, status, `duration_ms`, client IP), plus lifecycle events. Pipe stdout to a
file or your platform's log drain. `REPLAY_SHARE_LOG_LEVEL` (default `info`) tunes
verbosity.

Process-local counters are available at `GET /stats` as JSON — total requests by
status class, uploads (accepted / idempotent / bytes / rejected), rate-limit
hits, and server errors. The endpoint is **disabled unless a token is set**, and
then requires it:

```text
REPLAY_SHARE_STATS_TOKEN=<random-token>       # enables GET /stats behind this bearer
```

```sh
curl -H "authorization: Bearer $REPLAY_SHARE_STATS_TOKEN" https://<domain>/stats
```

Counters reset on restart — this is a lightweight liveness/volume view, not a
durable metrics store.

## Rate limiting

Requests are rate limited per client IP, with a stricter budget for the upload
path (`POST /v1/replays`) than for reads. Over-limit requests get `429` with a
`Retry-After` header; `GET /health` is exempt. Defaults (all overridable):

```text
REPLAY_SHARE_RATE_LIMIT_POINTS=120            # general requests per window
REPLAY_SHARE_RATE_LIMIT_DURATION=60           # window, seconds
REPLAY_SHARE_UPLOAD_RATE_LIMIT_POINTS=12      # uploads per window
REPLAY_SHARE_UPLOAD_RATE_LIMIT_DURATION=60
REPLAY_SHARE_TRUST_PROXY=false                # key on X-Forwarded-For when behind a proxy
```

Set a limit to `0` to disable that budget. Limits are in-memory and per process;
this is a single-instance service, so no shared store is used. When deployed
behind a reverse proxy, set `REPLAY_SHARE_TRUST_PROXY=true` so limiting keys on the
real client IP rather than the proxy's.

See the [Railway sharing guide](../../docs/phase-4-railway-sharing.md).
