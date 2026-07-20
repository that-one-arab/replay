# Phase 4A — Railway share links

## Scope

This first sharability slice uploads a completed portable artifact to a
Railway-hosted service and returns a replay link another person can open. It
deliberately does **not** add authentication, authorization, expiry, revocation,
encryption, or a general redaction policy. A link is an unlisted bearer link:
anyone who has it can view that replay. Use non-sensitive data.

## Architecture

`packages/share-server` receives a `.replay` artifact, uses the Phase 3 importer to
validate and atomically install the replay under its private spool, then serves
the existing player and replay API. Its Railway volume holds:

```text
/data
├── shares.json
└── spool/sessions/<session-id>/{manifest.json,events/,assets/}
```

The opaque share ID maps to the preserved replay session ID in `shares.json`.
The player needs no hosted-specific format because its existing
`/api/sessions/<session-id>/...` requests are served by the share service.

## Deploy to Railway

1. Create a Railway project from this repository. Railway uses
   [`railway.toml`](../railway.toml) and the included [`Dockerfile`](../Dockerfile).
2. Add a Railway Volume mounted at `/data`. Without it, shares disappear on
   redeploy because the container filesystem is ephemeral.
3. Generate a public Railway domain for the service.
4. Set these Railway variables:

   ```text
   REPLAY_SHARE_DATA_DIR=/data
   REPLAY_SHARE_PUBLIC_URL=https://<your-service-domain>
   REPLAY_SHARE_MAX_UPLOAD_BYTES=52428800
   ```

   Railway provides `PORT`. `REPLAY_SHARE_PUBLIC_URL` ensures returned links use
   the public domain rather than an internal host header.

5. Confirm `GET https://<your-service-domain>/health` returns `{"ok":true}`.

This is intentionally a single volume-backed instance. Object storage and
multiple writers are later scaling work.

## Publish a replay

Set the share endpoint locally, then explicitly publish a completed replay:

```sh
export REPLAY_SHARE_URL=https://<your-service-domain>
pnpm replay share replay_12345678
```

The command uses the automatic artifact from `capture_stop`, exporting it only
if it is absent. For a coding agent, configure the same `REPLAY_SHARE_URL` in the
environment that starts Replay MCP. Its normal `capture_stop` call then publishes
automatically and returns `shareUrl`; no additional share tool call is needed.

`replay_share { "sessionId": "replay_12345678" }` remains available to retry an
older completed replay. If automatic upload fails, `capture_stop` still
returns the local artifact and `shareError` rather than losing the replay.

## Manual acceptance check

1. Capture a small non-sensitive browser journey and stop it.
2. Run `pnpm replay share <session-id>` with `REPLAY_SHARE_URL` configured.
3. Open the returned link in a browser with no local Replay state.
4. Verify the replay, markers, captured assets, timeline seeking, tabs, and
   navigation transitions.
5. Redeploy the Railway service and reopen the link to verify the `/data` volume.

## Deferred work

Before any use beyond controlled testing, add access control, retention/expiry,
revocation, ownership, upload controls, auditability, and stronger capture
masking. Review comments and marker discussion remain outside this slice.
