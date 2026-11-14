# Phase 1: additive status schema and preserved history

Adds the component catalog, checks, rollups, incidents, maintenance, subscriber and prober-state tables. Imports legacy samples and events without changing the source tables. Unknown observations use null success values, excluded from uptime. Historical latency is null. Event text is replaced with a fixed public description to prevent previously private text leaking.

Migration: 0039_status_system.sql, additive only. Backfill is idempotent through unique legacy IDs and rollup keys. Test compares source/imported counts and replays the backfill.

Rollback: revert application code; retain the new tables and legacy history. Do not drop tables.

Validation output: notes/status-phase-1-checks.log. No production deployment.
