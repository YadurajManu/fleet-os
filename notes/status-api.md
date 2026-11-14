# Status system implementation

## Discovery

The existing Fastify monitoring collector is `control-plane/src/ops/public-status.ts`, registered by `src/api/ops.routes.ts`. It runs every 30 seconds and writes `public_status_samples` and `public_status_events` (migration 0038). The existing `/public/status` endpoint supplies `www/src/components/StatusPage.jsx`. It currently retains samples for 90 days and events for 180 days. These records are the authoritative historical source; do not replace them with generated history.

The database uses Drizzle with postgres-js and ordered SQL migrations under `control-plane/src/db/migrations`, registered in `meta/_journal.json`. Redis is available through AppContext. Agent and CLI are separate packages under `agent/` and `cli/`.

## Delivery plan

Use seven stacked branches and one PR per phase, with each later PR targeting its predecessor until merged. No server access or deployment. Migrations add tables and indexes only; rollback means reverting application code and leaving additive tables intact.

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
- No phase has been deployed. All runtime checks below target local services only.

## Implemented phases and evidence

1. Registered Drizzle tables and additive migration 0039. Backfill copies legacy observations with unique legacy IDs; a repeatable migration test checks three source rows remain three imported rows, one unknown is excluded from the two recorded checks, and the original event remains intact. Applied all migrations to a new local database `fleet_status_fresh_20261114` and to the existing isolated test database. See phase-1 log.
2. Added `npm run fleet-prober`: separately runnable bounded probes, jitter, sanitized failures and heartbeat. Legacy dependency checks reuse these implementations during transition. Local CLI smoke with `PROBE_INTERVAL_S=5` recorded two Postgres and two Redis observations and a fresh primary heartbeat; stopped cleanly.
3. Added state machine, grouped incidents, recovery, maintenance and hourly/daily rollups. Defaults: partial after two failures, major after three, recovery after three successes, degradation after five minutes above p95 1000ms or 5% error rate. Unknown never enters the uptime denominator. Retention is seven raw days, 90 hourly days, two daily years. Minute job runs in the prober.
4. Added public routes, explicit snapshot/series/incident/metric schemas, generated OpenAPI, ETag, 15s cache, SSE with real 20s heartbeat test, RSS/SVG/Statuspage output and verified subscriptions. Redis and disk retain a last-good snapshot; unreachable data becomes stale/unknown. Each aggregate requires five contributing users and nodes. Public fixtures/privacy tests include account, node, service and project names. GET rate budget is 15,000/minute/IP for the requested 200rps use case; public POST budget is 10/minute/IP.
5. Added standalone durable queue, authenticated replay-safe ingest (0040), numeric probe metadata (0041), atomic file/HTTP PUT/S3 SigV4 publication. Credentials and raw errors never enter public snapshots. Seven-day-old queued readings are refused; see limitations below.
6. Added private membership-scoped health routes. Cross-tenant list/detail tests pass. Added optional heartbeat RTT, reachability and certificate fields; fixed existing container restart/CPU metadata being stripped by heartbeat validation. Missing fields remain null. Existing node samples are explicitly not a complete uptime ledger.
7. Redesigned the status page using the site's actual tokens and wired live API, SSE/poll/snapshot fallback, accessible cards/ranges/ticks, incident archive, Status API docs and anonymous CLI status. Browser checks captured 18 requested mock-network scenarios plus two real-local-API screenshots. Keyboard controls, footer hit testing, label overlap and horizontal overflow checks passed at 1440/390. See notes/screenshots and individual logs.

## Local verification commands

- `npm run typecheck`, `npm run build`, `npm test` in control-plane, with `.env.test` pre-migration to local Postgres/Redis. Phase logs contain actual test output.
- `DATABASE_URL=postgres://fleetos:test@localhost:55432/fleet_status_fresh_20261114 npx tsx src/db/migrate.ts`: fresh local migration passed. Migration tests create an isolated schema on top of the current test schema and replay the backfill.
- `npx dotenv -e .env.test -- tsx scripts/status-load.ts`: 2,000 real HTTP requests in ten seconds, offered 200rps, zero failures, p95 11.95ms. This is a local cache benchmark, not a production performance guarantee.
- Website: build and 33 tests; CLI: typecheck/build and 223 tests. Browser screenshot and real API harnesses are in www/tests/status-visual.mjs and status-live.mjs.
- Agent: `go test ./...` passed; formatting checked with `gofmt -d`.
- None of these packages has a configured lint command; compiler checks, tests and `git diff --check` are used. This is not a claim that an unavailable linter ran.

## Blockers and disabled infrastructure

- Build, scheduler, tunnel, ingress, logs and GitHub-delivery canaries default off. Enable only with isolated operator-owned canary endpoints/credentials. Build and scheduler endpoints must actually execute the synthetic workflow and return success only once complete. No infrastructure was provisioned, so these external workflows cannot be verified here.
- Registry read/storage checks are implemented; tiny image push/pull needs an isolated writable repository and credentials. It remains unconfigured; do not claim push/pull coverage from a successful storage check.
- Postgres/Redis direct probes require integrated mode. Standalone mode uses independently configured HTTP/TLS/WebSocket probes and reports missing measurements unknown.
- Email subscriptions require existing RESEND_API_KEY plus MAIL_FROM; otherwise only webhook works. Webhooks must use a public HTTPS address and echo the challenge. Delivery checks reject private/reserved addresses and pin DNS resolution.
- Standalone S3/HTTP publication and real external webhook/email delivery have not been exercised against credentials. S3 session credentials are not supported. Local queue and ingest are tested.
- Median failover timing and unreported per-stage deployment timings remain null because the existing data has no reliable event-to-deployment timing link. Agent reachability/certificate/RTT fields are optional and are not synthesized by old agents.
- Configure STATUS_LATEST_CLI_VERSION with the independently verified release version; missing configuration returns null.
- Static snapshots have no fabricated uptime history. When the independent machine stops, the frontend checks snapshot age and marks it stale/unknown. Keep its queue directory persistent and monitor queue-full errors.
- The new page is validated locally against the API; it is not live on the production domain because deployment was explicitly prohibited.

## Improvements found during implementation

- Legacy checker exception strings could expose infrastructure; new probes use fixed public-safe errors and legacy imported event text is not copied into public incident descriptions.
- Keep both legacy tables indefinitely through migration review; final route removal never drops their history.
- The public uptime default uses measured coverage rather than manufacturing missing bars. High uptime with low coverage is shown alongside coverage and monitoring start.
- The existing frontend bundle-size warnings remain; this work adds no frontend dependency.
- Before production rollout, apply migrations, configure the separate prober, run a canary, and then deploy the page/router together. Restoring the preceding frontend/router commit is the application rollback; never delete historical tables to roll back.

## Final cutover

After the new page passed real local API checks at both widths, a separate final commit removed `/public/status` and its duplicate in-process checker. Operations incident collection remains unchanged. The original `public_status_samples` and `public_status_events` tables are untouched and remain available for audit and migration verification. Start the separate `fleet-prober` process when rolling out this version; a missing process yields unknown rather than fictitious operational status.
