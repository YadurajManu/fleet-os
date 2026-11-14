# Phase 5: independent prober queue and snapshots

Adds optional standalone mode with durable bounded queue, authenticated idempotent ingest and atomic file/HTTP PUT/S3 SigV4 snapshots. New migration 0040 adds ingest receipts only. All external setup remains manual. See docs/status-standalone.md.

Rollback: stop independent prober and revert code, leaving tables/data. No infrastructure provisioned. Validation: notes/status-phase-5-checks.log.
