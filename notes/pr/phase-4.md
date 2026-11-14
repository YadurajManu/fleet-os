# Phase 4: public aggregate API

Adds /v1/status routes, rollup-only history reads, generated route-registry OpenAPI, caching and conditional reads, SSE, badges, RSS, privacy-filtered incidents and admin incident writes. Legacy /public/status continues during transition. Missing anonymous metrics are null; never substitute customer-level data.

Rollback: revert router registration and this phase. Keep additive schema. Public snapshot is stored at STATUS_SNAPSHOT_PATH; contains only the public projection.

Validation: notes/status-phase-4-checks.log. No lint script exists. Subscriptions require verification; delivery implementation follows in this batch.
