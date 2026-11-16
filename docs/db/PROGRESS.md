# Fleet Databases progress

Resume here. Scope: REQUEST.md plus CONTINUATION.md; neither V1 nor V2 is complete. Branch: feat/db-v1. Status vocabulary: not started / in progress / verified. An acceptance scenario is verified only after its complete end-to-end flow runs; component tests below are explicitly partial evidence.

## Current work

Continuation milestone 1: engine plugin contract, maintained Postgres 16/17 (WAL-G/extensions), PgBouncer and Redis images, local private-registry integration and pre-pull. No remote registry publication is authorized. Local disposable registry tests are isolated test transfers, not releases. Native hardware: arm64 only; amd64 emulation/build and Windows cross-compilation must not be described as native runtime coverage.

Engine/image increment: `node --test --import tsx tests/database-plugins.test.ts` passes 6 tests; API typecheck passes; Go Docker package tests pass including pinned-image/cache/disk pre-pull checks. Maintained image builds are still running, and `database-plugins.docker.ts` must pass against their outputs before this milestone is verified. `control-plane/scripts/test-databases.mjs` now creates labeled isolated API test dependencies and runs the full required gate plus real engine/plugin checks. No product acceptance scenario has advanced to verified.

Latest evidence: all four native maintained images built locally. `node --test --test-concurrency=1 --import tsx tests/database-plugins.docker.ts` passed 3/3 with real Go resource creation, idempotent retries, clean stops/restarts, role ACLs, PgBouncer, all curated extensions, metrics and portable exports (including Postgres custom-dump restore). `node --test --import tsx tests/database-registry.docker.ts` passed 1/1 with a real authenticated registry and Go pre-pull/cache/disk test inside an isolated daemon; no host Docker settings or remote registry changed. The full native milestone gate is running and the dual-architecture OCI build is running; neither is claimed complete yet.

Live work to revalidate after context loss: native gate session 16123 (`deploy/databases/.native-milestone-gate.log`); multi-arch image build session 85191 (`deploy/databases/.build-multiarch.log`). Observe the actual handle/process before waiting/restarting. Builder ownership is recorded in ignored `deploy/databases/.build/builder.json`; `node deploy/databases/build.mjs --clean` removes only that builder after all builds/tests using it finish. Native test images remain in use by subsequent verification.

## Original V1 milestones

| # | Milestone | Status | Evidence / remaining proof |
| --- | --- | --- | --- |
| 0 | Understand and design | verified | docs/db/00-understanding.md and 01-design.md committed before feature code at ed4a38e; source review recorded in BUILD-NOTES.md. |
| 1 | Schema, engine contract, operations, negotiation | in progress | 0042 generated/applied; `node --test --import tsx tests/database-operations.test.ts tests/database-agent-capabilities.test.ts tests/migrations.test.ts` with disposable test config passed. Engine contract and actual execution still required. |
| 2 | Agent stateful runtime, TCP/exec/PTY, disk, images | in progress | Image/runtime implementation underway. No complete runtime verification yet. |
| 3 | Postgres lifecycle, placement, networking, links, pooler | not started | No product E2E proof yet. |
| 4 | Redis engine | in progress | `node --test --import tsx tests/database-engines.docker.ts` proves configuration behavior only; lifecycle/link API+CLI+UI are absent. |
| 5 | Targets, backups, restore, recover, import/export | not started | No engine-consistent recovery E2E proof yet. |
| 6 | Release migrations, config, exec/shell/migrate | not started | No release-gate E2E proof yet. |
| 7 | Monitoring, alerts, tuning | in progress | `node --test --import tsx tests/database-tuning.test.ts` passes; no metrics/alert product flow yet. |
| 8 | Complete CLI | not started | No Fleet Databases CLI E2E proof yet. |
| 9 | Complete dashboard | not started | No Fleet Databases Playwright proof yet. |
| 10 | Security, E2E, docs, release prep, V1 PR | not started | No V1 acceptance gate or PR yet. |

## V1 acceptance scenarios (REQUEST.md §10)

| # | Required scenario | Status | Exact evidence / missing proof |
| --- | --- | --- | --- |
| 1 | Create -> link -> push -> migration -> live app/backups; app replacement preserves data | not started | No full-flow command/test exists yet. |
| 2 | Restore deleted rows to timestamp T into new DB | not started | No PITR E2E proof. |
| 3 | Migration failure retains old app, restore point and actionable logs | not started | No failing-release E2E proof. |
| 4 | Offline -> unreachable/alert; no empty failover; recover with measured RPO | not started | No offline/recover E2E proof. |
| 5 | Localhost connect supports psql/Prisma Studio; revocation is immediate | not started | No live session/revocation proof. |
| 6 | Redis cache actually evicts; durable survives restart | in progress | `node --test --import tsx tests/database-engines.docker.ts` passes with official images; full Fleet-managed flow still missing. |
| 7 | External Postgres import -> portable export -> restore elsewhere | not started | No full import/export round trip. |
| 8 | Typed delete, final backup, grace-period recovery | not started | No deletion E2E proof. |
| 9 | Old agent runs services; DB action gives upgrade-required | in progress | `node --test --import tsx tests/database-agent-capabilities.test.ts tests/database-operations.test.ts` passes old HTTP registration/heartbeat + helper refusal; old-binary service/DB E2E missing. |
| 10 | No secrets in logs/errors/API/process args except authorized reveal | in progress | Operation input/history tests pass; complete runtime/backup/CLI/UI leak checks missing. |
| 11 | Playwright create, backup, both restores, link, delete | not started | No browser flow proof. |

## V2 work and acceptance gate

V2 starts only after the V1 gate is verified and its unmerged PR is open; branch feat/db-v2 from feat/db-v1.

| V2 area | Status | Missing proof |
| --- | --- | --- |
| Replicas and lag | not started | Real replication/bootstrap tests. |
| Manual promotion, fencing, safe rejoin | not started | Promotion/rejoin/fencing E2E. |
| Opt-in automatic failover | not started | Crash/partition/control-plane restart chaos tests. |
| Branches and TTL/preview lifecycle | not started | Isolation and cleanup E2E. |
| Masked clones | not started | Reviewed rules and source-isolation/anonymization tests. |
| Scheduled restore drills | not started | Real restored backup integrity evidence. |
| SQL console and browser | not started | Read/write authorization, limits, audit and Playwright. |
| Insights and disk forecast | not started | Measured query/index/bloat/growth fixtures. |
| Planned moves | not started | Cutover/outage/link restart E2E. |
| Resize and storage workflows | not started | Capacity/retuning and relocation E2E. |
| Major upgrades | not started | Rehearsal, cutover and rollback E2E. |
| Credential rotation | not started | Running-app zero-failed-request check. |
| Temporary grants | not started | Expiry/revocation and audit E2E. |
| Audit/export/RBAC | not started | Permission matrix and activity/export E2E. |
| Optional public TLS/IP access | not started | Routing evaluation, TLS/allowlist/revocation tests. |
| More targets and retention UI | not started | Real adapters, 3-2-1 retention/capacity tests. |
| Notification channels/routing | not started | Delivery, dedup and recovery tests. |
| More engines/PostGIS/Valkey evaluation | not started | Real engine integration and documented evaluation. |
| Maintenance windows | not started | Scheduling and urgent-operation bypass tests. |
| Full V2 UI, docs, hardening and PR | not started | Full gate and unmerged V2 PR. |

| V2 acceptance # | Required scenario | Status | Evidence |
| --- | --- | --- | --- |
| 1 | In-sync replica, fenced promote, safe old-primary rejoin | not started | Missing. |
| 2 | Agent/tunnel chaos respects safety and prevents split brain | not started | Missing. |
| 3 | Destructive branch migration leaves source intact; clone is masked | not started | Missing. |
| 4 | Scheduled restore drill reports real integrity result | not started | Missing. |
| 5 | Planned move completes with documented outage and updated links | not started | Missing. |
| 6 | Major upgrade rehearsed/applied with verified rollback | not started | Missing. |
| 7 | Rotation causes no failed app requests | not started | Missing. |
| 8 | Temporary grant expires and is audited | not started | Missing. |

## Regression evidence from previous increment

2026-11-16: full control-plane suite 697/697 passed; control-plane typecheck/build and `go test ./...` passed; explicit Docker engine suite 4/4 passed. See BUILD-NOTES.md. These results do not establish any untested product scenario. At every completed milestone rerun full API tests/typecheck/build, Go tests and the milestone's real Docker/E2E suite, then record exact results here.
