# Fleet Databases build notes

## 2026-11-16 — Discovery and design

- Starting revision: `4c041c1`, branch already `feat/db-v1`. Existing untracked workspace/Graphify/marketing/release files are preserved and excluded from commits.
- Read the repository instructions and queried the existing Graphify graph before focused source inspection. Added `00-understanding.md` and `01-design.md` before feature code.
- Differences: legacy databases expand into services; Redis there has no password; network is fleet-wide; no raw TCP tunnel; volume tar backups buffer in memory and are not engine-consistent PITR; no project table; dashboard already exists; current affinity is hard.
- Decision: retain legacy behavior and introduce separate tenant resources/runtime rather than convert live volumes. No production servers or Raunak data accessed.
- Friction: Docker Desktop was stopped. Started the installed app and verified a local Linux arm64 daemon. No disposable containers created yet.
- Migration risk: SQL history reaches 0041 but Drizzle snapshots stop at 0002. Reconcile metadata on a disposable database before new generated migrations; never rewrite applied SQL.
- Full V1/V2 scope is retained in REQUEST.md. Neither version nor any feature acceptance scenario is complete. No PR, release or registry publication performed.
- Next: foundations (schema, engine contract, durable operations/capabilities), then the matching API/UI in milestone order. All remaining V1 and V2 milestones require implementation and real verification.

## 2026-11-16 — Migration generation baseline

- Migrated a disposable Postgres 16 database through 0041. Generated the existing declared schema with Drizzle into a separate disposable database and compared every declared column's type, nullability and default against the migrated database: all 367 declared columns match.
- Found a generation bug in the existing JSONB `services.platforms` default: `.default('auto')` generated invalid SQL (`'auto'` is not JSON). Replaced the declaration with the existing database's actual `'"auto"'::jsonb` default. No live SQL or application value changes.
- Added the generator-produced current-schema snapshot at 0041 (with predecessor metadata linked to 0002), so future generation compares against current declarations. No historical migration SQL/journal entries changed.
- Two legacy SQL-only tables, `public_status_events` and `public_status_samples` (nine columns), remain in the migrated database and are intentionally not adopted or dropped by this database feature. The refreshed snapshot represents declared schema only.
- Disposable Postgres/Redis use random localhost ports and labels/names prefixed `fleet-db-v1-test`; no existing database or Redis instance used.

## 2026-11-16 — Foundations, first implementation increment

- Generated migration `0042_database_foundations` with Drizzle. Adds independent tenant database/credential/operation/event tables and additive node capability storage. Existing service and backup tables/semantics remain intact.
- New database records reserve their name until explicit purge; soft-deleted names cannot accidentally be recreated over a grace-period resource. Fleet/node foreign keys restrict removal while resource identities remain, rather than silently orphaning volumes. Creation APIs must add friendly safety errors before these resources become user-creatable.
- Implemented encrypted operation input, canonical keyed input fingerprints, project/fleet-scoped lookups, transactional enqueue, one active operation per database, exclusive claims, 30-second leases, fixed safe checkpoints, monotonic progress, bounded retry attempts, generation checks and durable cursor-paginated event history. Lease expiry requires reconciliation; it never silently treats an uncertain action as fresh work. Inputs/lease tokens/checkpoints are excluded from history output.
- No database worker is started and no feature endpoint/CLI/UI action is exposed yet. Engine/runtime handlers and the engine plugin contract are still needed; this is not the completed foundations milestone or V1.
- Added explicit capability parsing/storage and upgrade-required checks. Unknown well-formed future capability names are accepted, missing fields default to unsupported, duplicates are removed, and downgrade/missing reports clear prior flags. Go wire shape includes the additive capability list but advertises none until handlers exist.
- Verification on disposable Postgres 16/Redis 7: full control-plane suite **691/691 passed**; later capability/operation focused suite **10/10 passed** (includes two additional HTTP registration/heartbeat tests). Control-plane typecheck/build passed; `go test ./...` passed (some packages have no tests; default Docker tests do not prove hardware coverage). v0.2.4 HTTP compatibility exercised explicitly.
- Tests cover concurrent identical enqueue, conflicting idempotency inputs, encrypted input/history privacy, fleet/project isolation, competing claims, checkpoint resume, expired/stale lease rejection, generation changes, retry exhaustion, invalid input/progress/error codes and schema safety constraints.
- Reproduce focused tests with disposable `DATABASE_URL`/`REDIS_URL` and test config: `npx dotenv -e .env.test -- node --test --test-concurrency=1 --import tsx tests/database-agent-capabilities.test.ts tests/database-operations.test.ts tests/migrations.test.ts` from `control-plane/`. Never point test variables at a deployed installation.

## 2026-11-16 — Engine tuning groundwork

- Implemented bounded Postgres profiles with memory shared between server and a future PgBouncer sidecar, combined pool caps, concurrent work-memory budgeting, checkpoint/WAL/autovacuum settings, SCRAM/logging defaults, allowlisted numeric overrides and SD-storage warnings.
- Implemented explicit Redis cache/durable configurations, memory headroom, persistence/eviction settings and honest warnings. ACL file is required; credential creation/runtime mounting are not yet implemented.
- `database-tuning.test.ts`: **4/4 passed**, covering profile budgets, override rejection, storage behavior and Redis modes.
- `database-engines.docker.ts`: **4/4 passed with real Docker**, separately testing Postgres 16/17 settings/pg_stat_statements/row persistence and Redis cache/durable authentication, eviction/write refusal and restart behavior. Disposable tenant-engine fixtures are separate from the control-plane test container and are cleaned up, including their volumes/credential files.
- Local Linux arm64 on Docker Desktop only; no Windows or amd64 hardware claim. These tests use official engine images and do not establish maintained-image, PgBouncer, backup/PITR, agent-runtime or product E2E readiness.
- Actual tuning behavior, limitations, units and official references are recorded in `tuning.md`. API/UI wiring and the complete engine plugin contract remain ahead.

## 2026-11-16 — Increment verification

- Final full control-plane suite: **697/697 passed**, zero skipped, after all new tests were included. Control-plane typecheck and build passed. All Go package tests passed.
- Explicit Docker engine suite: **4/4 passed**. The real-container configuration checks are run separately from the default API suite using the command in `tuning.md`.
- Applied generated migration 0042 to a separately populated pre-change declared-schema fixture: existing service name/image/platform values were unchanged and the pre-existing node received an empty/unsupported capability list.
- Refreshed the code graph with `graphify update .`: 4,273 nodes / 10,497 edges. Community names changed and some were automatically named from hubs; semantic documentation extraction was not refreshed.
- Temporary test containers/volumes and `.db-build` scratch files are removed after verification. Existing untracked workspace files remain untouched. No production validation or deployment performed.

## Outstanding work (unchanged scope)

All V1 product acceptance scenarios and all V2 scenarios in REQUEST.md remain incomplete. Still required: complete engine contract and maintained images, agent stateful runtime/TCP/exec, scheduler accounting/placement, lifecycle API plus matching UI, role/link injection and PgBouncer, targets/encrypted streamed backups/PITR/recovery/import/export, deploy migration gate/declarative transition, metrics/alerts, complete CLI/UI, hardening/E2E/Playwright, docs/runbooks and release preparation. V1 PR has not been opened, V2 branch has not been created, and no npm/agent/image release has been published. Raunak has not been accessed or changed.
