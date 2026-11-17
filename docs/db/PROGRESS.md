# Fleet Databases progress

Resume here. Scope: REQUEST.md plus CONTINUATION.md; neither V1 nor V2 is complete. Branch: feat/db-v1-runtime, advanced to main merge `55420b4` after user-authorized foundations PR #35. Status vocabulary: not started / in progress / verified. An acceptance scenario is verified only after its complete end-to-end flow runs; component tests below are explicitly partial evidence.

Foundations PR #35 is merged on explicit user instruction. This does not mark V1 complete; the eventual V1/V2 product PR gates remain unchanged.

## Current work

Continuation milestone 1 is verified: engine contract, maintained images, private registry resolution and agent image pre-pull. The worker and scheduler component gates are verified. Lifecycle API/CLI/dashboard work is in progress: catalog, placement, create, list/detail, start/stop/restart and durable progress are wired. Database links now have encrypted connection-secret injection, project-scoped API/CLI/dashboard controls, soft placement preference and same-node private-network attachment. Runtime/TCP/exec tunnel handlers are enabled on Linux arm64/amd64 engines; backup/metrics capabilities remain disabled.

Milestone 1 gate: `node control-plane/scripts/test-databases.mjs` completed with **703/703 control-plane tests**, typecheck, build, `go test ./...`, and **8/8 real Docker checks** passing. The Docker checks cover official engine tuning (4), maintained engine/Go resource lifecycle/roles/pooler/extensions/metrics/export (3), and authenticated dual-architecture registry resolution plus real Go pre-pull/cache/disk guards (1). Disposable test dependencies and registry resources were removed.

The CLI now supports `fleet db list|link|unlink|connect|exec`; link/unlink accept exact database and service names or IDs, with `--project` resolving duplicate database names. `db connect` forwards loopback TCP through an authenticated, revocable control-plane WebSocket and the existing bounded agent stream. `db exec` sends Redis command arguments or Postgres SQL on stdin, selects only app/readonly credentials, and streams stdout/stderr with local backpressure. CLI typecheck and **226/226 tests** pass. A real Docker test used the CLI to AUTH/PING Redis through two agents, ran Redis `PING` and Postgres `SELECT 1` through the exec tunnel, and used the PostgreSQL JS driver to run `SELECT 1` through the local TCP forwarder. Unauthorized access was rejected and session revocation disconnected the Redis client. Native `psql`/Prisma Studio compatibility and API-to-live-app rollout remain unverified; no cross-node application connector exists yet.

Cross-platform evidence: `FLEET_DB_PLATFORMS=linux/arm64,linux/amd64 node deploy/databases/build.mjs` built all four OCI indexes. `python3 deploy/databases/verify-oci.py` verified every referenced blob/checksum and both platform configurations before local Docker import. Checked scratch archives were then removed to recover host disk space; ignored verification metadata remains. `FLEET_DB_TEST_PLATFORM=linux/amd64 node --test --test-concurrency=1 --import tsx tests/database-plugins.docker.ts` passed **3/3** under Docker Desktop emulation. Agent `CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build ./cmd/agent` compiled Linux arm64/amd64, Windows amd64 and Darwin arm64. Native hardware is arm64 only; no native amd64 or Windows runtime coverage is claimed.

Runtime helper work has begun but is not part of milestone 1 completion: private, credential-free receipts and a binary stdio/TCP helper have focused unit coverage. WSS/runtime Docker E2E, cancellation and runtime/TCP/exec advertisement now pass the gates recorded below. Storage/stability reporting and the database worker remain ahead. No product acceptance scenario is verified.

## Original V1 milestones

| # | Milestone | Status | Evidence / remaining proof |
| --- | --- | --- | --- |
| 0 | Understand and design | verified | docs/db/00-understanding.md and 01-design.md committed before feature code at ed4a38e; source review recorded in BUILD-NOTES.md. |
| 1 | Schema, engine contract, operations, negotiation | in progress | 0042 generated/applied; `node --test --import tsx tests/database-operations.test.ts tests/database-agent-capabilities.test.ts tests/migrations.test.ts` with disposable test config passed. Engine contract and actual execution still required. |
| 2 | Agent stateful runtime, TCP/exec/PTY, disk, images | in progress | Image/runtime implementation underway. No complete runtime verification yet. |
| 3 | Postgres lifecycle, placement, networking, links, pooler | in progress | Create/catalog/placement/list/detail/start/stop/restart and link/unlink API, CLI and dashboard are wired. Link tests verify encrypted role URLs and cleanup; real Docker verifies an agent-created service can query Postgres through a same-node private project network. Still missing a complete lifecycle API-to-app rollout proof, cross-node application TCP connector, delete/recover, connect/shell/exec and browser acceptance. |
| 4 | Redis engine | in progress | `node --test --import tsx tests/database-engines.docker.ts` proves configuration behavior only; lifecycle/link API+CLI+UI are absent. |
| 5 | Targets, backups, restore, recover, import/export | in progress | Migration 0045 adds project-scoped S3-compatible target metadata and an optional tenant database target reference. API, MinIO connectivity/streaming, backup operations, restore and import/export remain unimplemented. No engine-consistent recovery E2E proof yet. |
| 6 | Release migrations, config, exec/shell/migrate | not started | No release-gate E2E proof yet. |
| 7 | Monitoring, alerts, tuning | in progress | `node --test --import tsx tests/database-tuning.test.ts` passes; no metrics/alert product flow yet. |
| 8 | Complete CLI | in progress | Lifecycle list/create/actions, link/unlink, loopback `db connect`, and Redis/Postgres `db exec` are wired. Interactive database shell, backup/recovery and declarative release commands remain. |
| 9 | Complete dashboard | in progress | Create wizard, list/detail, lifecycle controls and reconnecting SSE progress are wired. Playwright and backup/delete/link flows remain. |
| 10 | Security, E2E, docs, release prep, V1 PR | not started | No V1 acceptance gate or PR yet. |

## V1 acceptance scenarios (REQUEST.md §10)

| # | Required scenario | Status | Exact evidence / missing proof |
| --- | --- | --- | --- |
| 1 | Create -> link -> push -> migration -> live app/backups; app replacement preserves data | not started | No full-flow command/test exists yet. |
| 2 | Restore deleted rows to timestamp T into new DB | not started | No PITR E2E proof. |
| 3 | Migration failure retains old app, restore point and actionable logs | not started | No failing-release E2E proof. |
| 4 | Offline -> unreachable/alert; no empty failover; recover with measured RPO | not started | No offline/recover E2E proof. |
| 5 | Localhost connect supports psql/Prisma Studio; revocation is immediate | in progress | Real Docker test proves CLI local TCP forwarding, Redis AUTH/PING, Redis `db exec`, Postgres `psql -f -` executing `SELECT 1`, and PostgreSQL JS-driver `SELECT 1` over the local `db connect` port. Native `psql`/Prisma Studio over that port and revocation timing under a normal database client remain unverified. |
| 6 | Redis cache actually evicts; durable survives restart | in progress | `node --test --import tsx tests/database-engines.docker.ts` passes with official images; full Fleet-managed flow still missing. |
| 7 | External Postgres import -> portable export -> restore elsewhere | not started | No full import/export round trip. |
| 8 | Typed delete, final backup, grace-period recovery | not started | No deletion E2E proof. |
| 9 | Old agent runs services; DB action gives upgrade-required | in progress | `node --test --import tsx tests/database-agent-capabilities.test.ts tests/database-operations.test.ts` passes old HTTP registration/heartbeat + helper refusal; old-binary service/DB E2E missing. |
| 10 | No secrets in logs/errors/API/process args except authorized reveal | in progress | Operation input/history tests pass; complete runtime/backup/CLI/UI leak checks missing. |
| 11 | Playwright create, backup, both restores, link, delete | not started | No browser flow proof. |

## 2026-11-17 — Backup target schema foundation

- Generated migration 0045 adds project-scoped S3-compatible target metadata, stores credentials only as an encrypted envelope, permits one default target per fleet/project, and adds an optional target reference to tenant databases. A database can still be created without a target, matching the design's explicit no-off-node-backup state.
- `node control-plane/scripts/test-databases.mjs --worker` passed: migration applied, **723/723** control-plane tests, Prettier/Oxlint, TypeScript typecheck/build, `go test ./...`, and the real two-agent Docker tunnel/worker check **1/1**. The Docker transfer completed 2 MiB at 100 ms RTT in 2.87 seconds versus the 12.8-second stop-and-wait lower bound. Backup-target API/CLI/UI, MinIO connectivity and object streaming are not implemented or verified; no backup acceptance scenario is marked complete.

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

## 2026-11-17 — Protocol commit 1 of 4

Control-plane relay now negotiates a 16-frame window and retains a one-frame fallback. Credits are returned as the readable buffer drains; sending stops when the window is exhausted. Unit tests cover credit bounds, old peers, slow readers, invalid acknowledgements, out-of-order/oversize frames and excessive credit use. At simulated 100 ms RTT, a 2 MiB transfer measured 6.47 seconds with one frame and 0.41 seconds with 16 (15.7x faster). This is a protocol test, not the pending two-node Docker proof. Capability flags remain disabled. Commands: `node --test --import tsx tests/database-tunnel.test.ts`; `npx prettier --check --single-quote --no-semi src/databases/tunnel.ts tests/database-tunnel.test.ts`; `npx --yes oxlint@1.57.0 src/databases/tunnel.ts tests/database-tunnel.test.ts`; `npx tsc --noEmit`.

Verification for protocol commit: full control-plane suite **711/711 passed**, typecheck/build passed, `go test ./...` passed. The repeatable disposable-dependency command is `node control-plane/scripts/test-databases.mjs --unit-only` (excludes maintained-image/registry integration, which remains a separate gate). Focused protocol tests **8/8 passed**; Oxlint 1.57.0 reports zero warnings/errors.

## 2026-11-17 — Agent commit 2 of 4

Matching Go stream negotiation selects 16 frames only when requested, otherwise one. Input queues and unconsumed-frame counts are bounded; output waits when credit is exhausted and drains acknowledgements before closing. Go tests cover both windows, invalid frames, exhausted credit and cancellation. `go test ./...`, `go vet ./...` and `go test -race ./internal/database ./internal/dbproxy ./internal/docker` passed. Stateful runtime receipts, client process cancellation and the private container TCP helper are included as handler prerequisites; capabilities remain disabled.

A fresh Docker Desktop session has no maintained runtime images. Re-running the Docker runtime tests failed during image lookup, before runtime creation; rebuilding the pinned local images is in progress. Build utility now restores its pinned BuildKit wrapper image even when the saved builder metadata survives an empty image store. No new Docker/two-node verification is claimed by this commit. Previous runtime-only Docker evidence is recorded above.

## 2026-11-17 — Real tunnel test, commit 3 of 4

`node --test --test-concurrency=1 --import tsx tests/database-tunnel.docker.ts tests/database-runtime.docker.ts` passed **4/4**. Two actual Go tunnel agents with separate node identities share the local Docker host; the database is a private Redis container and the other agent runs a real service task reading through the tunnel. The task's returned SHA-256 matches the stored 2 MiB payload. Both WebSocket directions have 50 ms delivery delay (100 ms RTT). Upload/download took **2.97 s** versus the 12.8 s stop-and-wait lower bound; the protocol-only comparison measured 6.47 s versus 0.41 s. Mid-transfer tunnel closure interrupts the 8 MiB write, reconnects the actual agent and permits a fresh complete transfer. Interrupted writes are never automatically replayed.

Maintained Postgres 16/17 and Redis runtime lifecycle/receipt/private TCP checks also passed. Fixture containers/volumes are identified by their database UUID; service tasks carry node/task ownership labels and are cleaned by the existing task runner. Database ports stay unpublished; the disposable test client uses a loopback-only forwarding listener. This is local logical-node coverage, not two physical machines or Windows coverage.

Added reproducible `npm run db:format:check` and `npm run db:lint` commands pinned to Prettier 3.10.1 and Oxlint 1.57.0. Applied readable formatting to newly introduced database TypeScript files. Capability flags stay disabled until the final gate/commit.

## 2026-11-17 — Capability gate, commit 4 of 4

Enabled only `database.runtime.v1`, `database.tcp.v1` and `database.exec.v1` for supported Linux arm64/amd64 container engines. ARMv7 receives no database flags; backup/metrics flags remain off. Repeated Docker gate: **7/7 passed** (maintained engines, durable runtime, actual two-agent service/tunnel/drop/reconnect). Repeated 2 MiB upload/download at 100 ms RTT: **2.89 s** against 12.8 s stop-and-wait lower bound. Cross-compilation passed Linux arm64/amd64, Windows amd64 and Darwin arm64. See tunnel.md for the wire contract and buffer bounds.

Next milestone: lease-based database worker, restart reconciliation, retries and persisted progress. No product acceptance scenario is promoted to verified by this component gate.

Runtime draft PR: https://github.com/YadurajManu/fleet-os/pull/36 (unmerged). Capability gate full control-plane regression: **711/711 passed**, zero failures/skips. Pinned formatting/lint checks passed.

## 2026-11-17 — Database worker milestone

- Installed the worker in the control-plane startup/shutdown lifecycle. It claims only implemented create/start/stop/restart jobs, renews exclusive leases, validates encrypted server-generated intents against the pinned database identity, and resends the original operation ID after uncertain replies. Raw exceptions and runtime inputs never enter operation events. Retry exhaustion and stale-generation fencing reuse the durable lease framework.
- Physical lifecycle confirmation and database status/desired-state updates now commit atomically with operation success. An expired worker cannot update either. Shutdown cancels outstanding RPCs and preserves uncertain leases for reconciliation.
- Added a durable cursor-based progress generator for the lifecycle SSE adapter; it reads only the existing sanitized event projection and supports abort/resume. The HTTP SSE route lands with matching lifecycle API/CLI/UI, not as an unfinished standalone endpoint.
- Real Docker/Postgres test: enqueue create through the worker; physically restart with an unfinished lease; reconstruct the worker; expire the old lease; reconcile without changing the container start time. Also queues a stop while disconnected, reconstructs the worker, reconnects, confirms stopped status/desired state, starts again and verifies service traffic. Progress reaches 100, resumes from a cursor and excludes credentials.
- `node control-plane/scripts/test-databases.mjs --worker`: **712/712 control-plane tests**, formatter/lint, typecheck/build, Go tests and **1/1 real two-agent Docker worker test passed**. Focused lease-boundary test covers competing claims, sanitized invalid input and refusal of expired atomic completion. `--worker-only` runs the disposable migration/Go/worker-Docker fixture for diagnosis. The harness uses generated test-only JWT/encryption secrets and disposable database/Redis endpoints.
- Next: stateful scheduler accounting, stable placement recommendations, soft database co-location and offline preservation. Product acceptance scenarios remain unverified until complete API/CLI/UI end-to-end flows run.

## 2026-11-17 — Stateful scheduling component gate

- Fleet snapshots reserve tenant database RAM/CPU/disk even when stopped or unreachable, including the soft-delete grace period. App builds and one-off task reservations already consume this shared snapshot, so they now see database commitments. Disk accounting is conservative: full declared database budgets are subtracted from measured free space until per-volume metrics can account for used bytes precisely.
- Stateful placement preserves existing volume/node pins. Node-down handling marks tenant databases unreachable without moving their node, volume or generation, including fleets with no app deployments. Existing app hard affinity is unchanged; optional soft node preferences add rank and show a cross-node latency warning when unmet. Link-derived preferences are wired when the link model lands.
- Database recommendations require verified runtime capability, a supported image architecture, measured disk headroom, spare CPU and memory safety margin. Ranking includes measured host uptime and bounded 30-day observed node-down transitions. The outage history survives control-plane process restarts in Redis; a control-plane restart itself does not add a flap. Warnings cover limited stability and operator-labeled SD storage; an unmeasured storage type is stated explicitly rather than guessed from CPU architecture.
- Non-builder agents now run the existing safe disk probe too, so database eligibility does not require opting into builds. The real two-agent fixture verifies non-builder disk reporting while leaving build capability disabled.
- `node control-plane/scripts/test-databases.mjs --worker`: **717/717 control-plane tests**, formatter/lint, typecheck/build, Go tests and the real two-agent worker/tunnel test passed. Pure scheduler and legacy scheduler checks passed **33/33**. Real Postgres/Redis fixture proves stopped reservations, uptime/outage observations and offline pin preservation. Product offline/recovery acceptance remains pending full lifecycle, alerts and backup recovery.
- Next: lifecycle API, CLI and dashboard wizard using these recommendations and leased jobs. No production resources or Raunak data were used.

## 2026-11-17 — Lifecycle API, CLI and dashboard work in progress

- Added project-scoped catalog and placement endpoints, fleet database pagination, create with server-side placement revalidation, pinned digest image identities, encrypted role credentials, lifecycle actions, detail/history and authenticated cursor-resumable progress SSE. Validation failures at route trust boundaries return stable 4xx errors. Database errors/progress projections omit operation secrets.
- Added the dashboard create wizard, capacity recommendation review, resource list/detail, start/stop/restart controls and reconnecting progress stream. Added `fleet databases list|create|start|stop|restart`; action/create commands carry an idempotency key and follow durable operation state unless `--no-wait` or `--json` is used.
- Added migration 0043 for pinned image references. CLI and dashboard formats/builds and API route tests are included. `node control-plane/scripts/test-databases.mjs --worker` passed: **719/719 control-plane tests**, formatter/lint, typecheck/build, `go test ./...`, and the real delayed two-agent Docker tunnel test (2 MiB at 100 ms RTT: 2.83 s versus a 12.8 s stop-and-wait lower bound). Dashboard typecheck, **31/31 tests** and build passed. CLI typecheck and **223/223 tests** passed.
- This is component/API coverage, not a full create-through-authenticated-API-to-live-agent acceptance run. Delete/final backup, recover, links/env injection, connection clients and browser E2E remain unimplemented; do not mark a product scenario verified. No PR merge, publishing, production access or Raunak data use.
