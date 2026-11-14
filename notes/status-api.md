# Status system implementation

## Discovery

The existing Fastify monitoring collector is `control-plane/src/ops/public-status.ts`, registered by `src/api/ops.routes.ts`. It runs every 30 seconds and writes `public_status_samples` and `public_status_events` (migration 0038). The existing `/public/status` endpoint supplies `www/src/components/StatusPage.jsx`. It currently retains samples for 90 days and events for 180 days. These records are the authoritative historical source; do not replace them with generated history.

The database uses Drizzle with postgres-js and ordered SQL migrations under `control-plane/src/db/migrations`, registered in `meta/_journal.json`. Redis is available through AppContext. Agent and CLI are separate packages under `agent/` and `cli/`.

## Delivery plan

Use eight stacked branches and one PR per phase, with each later PR targeting its predecessor until merged. No server access or deployment. Migrations add tables and indexes only; rollback means reverting application code and leaving additive tables intact.

1. Add Drizzle status tables, indexes, component seeds and historical backfill. Preserve source sample/event IDs for idempotent migration. Keep unknown checks out of uptime denominators. Historical latency must remain null because it was never measured.
2. Add a separately runnable prober with bounded timeouts, jitter and heartbeat. Disable infrastructure-dependent canaries until configured; do not infer successful results from missing configuration.
3. Add hysteresis, dependency incident grouping, maintenance suppression and rollups/retention. Defaults: two failures partial outage, three major, three successes recovery; sustained degradation five minutes. Stale after two probe intervals is unknown.
4. Add versioned public aggregate routes, explicit schemas, OpenAPI, cache/ETag/SSE, privacy tests and subscriptions. Retain the legacy endpoint during migration. Ensure fallback snapshots contain only approved public fields.
5. Add optional standalone queue, authenticated ingest and atomic snapshot publication, with configuration documentation. Provision nothing.
6. Add private health routes using existing ownership checks and telemetry; missing measurements remain null. Verify tenant boundaries.
7. Wire the existing status page, add docs and CLI public status output; remove the legacy path only in a separate commit after consumer migration. Capture requested desktop/mobile states.

## Validation

Each PR records actual check output, migration/rollback notes and limitations. State, rollup, privacy, tenant and integration tests are required. The load target is 200 requests/second, p95 below 50ms; do not claim it without a measured run. Never run migrations against production. Check package scripts before selecting lint/build/test commands.

## Friction and decisions

- The old collector deletes history on each collection. The replacement must preserve historical rollups before shortening raw retention.
- Legacy samples have no latency/status-code measurements. Backfill only facts that were recorded.
- The current collector considers the API operational simply because it is executing. Independent canaries must measure reachability separately.
- No phase has been deployed. Implementation and verification progress must be appended here.
