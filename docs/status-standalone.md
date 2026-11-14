# Independent status monitoring

Apply additive migrations 0039/0040 on your own schedule, then run `npm run fleet-prober` in control-plane with its development or production configuration. This change provisions nothing. Stop the old in-process status collector only after frontend migration; its legacy tables remain intact.

On an independent machine, install the control-plane package dependencies and set `STATUS_STANDALONE_PROBER=true`. Standalone mode requires no database or control-plane JWT credentials. Set explicit `PROBE_*_URL` values to operator-owned endpoints. Leave infrastructure canaries disabled until you have dedicated canary infrastructure.

Set `STATUS_INGEST_URL=https://your-api/v1/status/ingest` and a random `STATUS_INGEST_TOKEN` of at least 32 characters on both machines. Queued batches are persisted atomically at `STATUS_QUEUE_PATH`. Ingest receipts prevent duplicate raw checks after a network retry. Observations older than seven days must be archived manually; the server refuses them rather than rewriting retained rollups. Queue limit is 10,000 batches; monitor the process stderr and disk space.

Set `STATUS_PUBLISH_PATH` to a file served by your independent static host. Optional `STATUS_PUBLISH_URL` uploads using HTTP PUT and `STATUS_PUBLISH_TOKEN`. Alternatively set `STATUS_S3_URL` to the complete HTTPS bucket/object URL, `STATUS_S3_REGION`, `STATUS_S3_ACCESS_KEY` and `STATUS_S3_SECRET_KEY`. The S3 target uses SigV4. Restrict the credential to writing this one object. This version supports long-lived S3 keys, not temporary session credentials.

The static snapshot must be served with public GET CORS and a short cache lifetime. Set the website's `VITE_STATUS_SNAPSHOT_URL` to this URL. Standalone snapshots include only measured component states; no fabricated historical ticks. Unconfigured probes are unknown. Retained queued readings reconstruct current state after restart; historical API rollups remain authoritative.

Canary contracts: build and scheduler URLs must execute an isolated canary and return 2xx only after successful completion, within the configured timeout. Do not point them at a basic health route. The GitHub delivery canary must check recent success and lag. Registry push/pull requires an isolated writable canary repository and is not enabled by the read-only storage probe. Redis/Postgres direct checks run in integrated mode; standalone observes them through configured independent infrastructure probes.

Rollback: stop the prober and revert the router registration/code; leave additive tables and original history intact. No rollback migration deletes data.
