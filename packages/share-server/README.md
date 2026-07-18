# `@signit/rec-share-server`

The hosted replay service used by the Railway prototype. It accepts a validated
portable `.rec` artifact, imports it into its private spool, and serves the
existing player through an opaque bearer link.

Required deployment settings:

```text
REC_SHARE_DATA_DIR=/data
REC_SHARE_PUBLIC_URL=https://<your-service-domain>
REC_SHARE_MAX_UPLOAD_BYTES=52428800
```

Use persistent storage for `REC_SHARE_DATA_DIR`; without it, uploads disappear on
redeploy. This package intentionally provides unlisted bearer links only. Access
control, retention, expiry, revocation, and auditability are later work.

See the [Railway sharing guide](../../docs/phase-4-railway-sharing.md).
