# Fleet Databases progress

Resume here. Scope: REQUEST.md plus CONTINUATION.md; neither V1 nor V2 is complete. Branch: feat/db-v1-runtime, advanced to main merge `55420b4` after user-authorized foundations PR #35. Status vocabulary: not started / in progress / verified. An acceptance scenario is verified only after its complete end-to-end flow runs; component tests below are explicitly partial evidence.

Foundations PR #35 is merged on explicit user instruction. This does not mark V1 complete; the eventual V1/V2 product PR gates remain unchanged.

## Current work

Continuation milestone 1 is verified: engine contract, maintained images, private registry resolution and agent image pre-pull. The worker and scheduler component gates are verified. Lifecycle API/CLI/dashboard work is in progress: catalog, placement, create, list/detail, start/stop/restart and durable progress are wired. Database links now have encrypted connection-secret injection, project-scoped API/CLI/dashboard controls, soft placement preference and same-node private-network attachment. Runtime/TCP/exec tunnel handlers are enabled on Linux arm64/amd64 engines; backup/metrics capabilities remain disabled.

Recovery chain work is in progress. New backup targets receive an independent random libsodium key inside the existing encrypted credential envelope. When a Postgres target is attached, the engine plan mounts target credentials, key and `.pgpass` as mode-0600 secret files and configures WAL-G archive/replay commands with a 60-second archive timeout. WAL-G prefixes now isolate each fleet, database and generation. Fleet-managed manual base backups run through a durable API/worker operation and record a WAL-G recovery point; real Docker with MinIO verifies the created objects. An engine-level Docker test restores a WAL-G base to a distinct data volume, replays WAL to a timestamp and promotes the recovered database. Fleet-managed restore/PITR/recover, durable per-object base/WAL manifests, scheduled backups and retention remain. A running database still needs a restart after target selection before the archive configuration is active.

Fleet-managed manual PostgreSQL base backups now have a dedicated API operation, durable manifest row, and lease-backed worker execution over the authenticated database tunnel. The worker records the WAL-G backup identifier and recovery timestamps after WAL-G can list the new backup; the Docker API/worker/agent test confirms base objects in real MinIO. The engine test also performs PITR from a WAL-G base to a timestamp. Scheduling, durable object manifests/checksums, restore/recover flows and retention remain open.

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
| 3 | Postgres lifecycle, placement, networking, links, pooler | in progress | Create/catalog/placement/list/detail/start/stop/restart and link/unlink API, CLI and dashboard are wired. Link tests verify encrypted role URLs and cleanup; real Docker verifies an agent-created service can query Postgres through a same-node private project network. Typed delete with a recent verified final backup, seven-day soft-delete grace, and row-preserving restore/restart now passes real Docker. A complete lifecycle API-to-app rollout proof, cross-node application TCP connector, interactive shell and browser acceptance remain. |
| 4 | Redis engine | in progress | `node --test --import tsx tests/database-engines.docker.ts` proves configuration behavior only; lifecycle/link API+CLI+UI are absent. |
| 5 | Targets, backups, restore, recover, import/export | in progress | Migrations 0045–0046, scoped target API, real Docker MinIO probe, CLI/dashboard target management and per-database selection exist. Migration 0046 adds durable backup manifests and retention-safe foreign keys. The lease-backed manual base-backup API/worker now records the WAL-G recovery point; real API/worker/agent/Docker tests confirm its objects in MinIO. Fleet-managed scheduling, complete object manifests/checksums, restore/PITR, recovery and end-to-end import remain. |
| 6 | Release migrations, config, exec/shell/migrate | not started | No release-gate E2E proof yet. |
| 7 | Monitoring, alerts, tuning | in progress | `node --test --import tsx tests/database-tuning.test.ts` passes; no metrics/alert product flow yet. |
| 8 | Complete CLI | in progress | Lifecycle list/create/actions, typed delete with `--backup`/`--confirm`, grace restore, link/unlink, loopback `db connect`, and Redis/Postgres `db exec` are wired. Interactive database shell, backup/recovery and declarative release commands remain. |
| 9 | Complete dashboard | in progress | Create wizard, list/detail, lifecycle controls, typed delete with recent verified backup selection, grace restore and reconnecting SSE progress are wired. Playwright and remaining backup/recovery flows remain. |
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
| 8 | Typed delete, final backup, grace-period recovery | verified | Real API/worker/agent/Docker/MinIO flow required exact-name confirmation and a recent verified final backup, removed only owned runtime/config resources, retained the data volume, restored inside the grace period, restarted, and queried the original row. Automatic expiry/purge and Playwright coverage remain open. |
| 9 | Old agent runs services; DB action gives upgrade-required | in progress | `node --test --import tsx tests/database-agent-capabilities.test.ts tests/database-operations.test.ts` passes old HTTP registration/heartbeat + helper refusal; old-binary service/DB E2E missing. |
| 10 | No secrets in logs/errors/API/process args except authorized reveal | in progress | Operation input/history tests pass; complete runtime/backup/CLI/UI leak checks missing. |
| 11 | Playwright create, backup, both restores, link, delete | not started | No browser flow proof. |

## 2026-11-17 — Backup target schema foundation

- Generated migration 0045 adds project-scoped S3-compatible target metadata, stores credentials only as an encrypted envelope, permits one default target per fleet/project, and adds an optional target reference to tenant databases. A database can still be created without a target, matching the design's explicit no-off-node-backup state.
- `node control-plane/scripts/test-databases.mjs --worker` passed: migration applied, **723/723** control-plane tests, Prettier/Oxlint, TypeScript typecheck/build, `go test ./...`, and the real two-agent Docker tunnel/worker check **1/1**. The Docker transfer completed 2 MiB at 100 ms RTT in 2.87 seconds versus the 12.8-second stop-and-wait lower bound. Backup-target API/CLI/UI, MinIO connectivity and object streaming are not implemented or verified; no backup acceptance scenario is marked complete.

## 2026-11-17 — Backup target API slice

- Added authenticated project-scoped list/create/delete routes. Target credentials are encrypted before persistence, excluded from API projections and audit metadata, and redacted from request logs. Defaults are replaced transactionally; plain HTTP is accepted only for loopback MinIO development endpoints. Delete detaches database target references without deleting database data.
- `node control-plane/scripts/test-databases.mjs --unit-only` passed: **724/724** control-plane tests, including the new target API integration test; formatter/Oxlint, TypeScript typecheck/build and `go test ./...` passed. CLI/UI and backup streaming remain outstanding; no backup acceptance scenario is verified.

## 2026-11-17 — Backup target connectivity probe

- Added the authenticated target test route. It writes a random object below the configured prefix, reads and compares it, then removes only that object. `lastTestedAt` and sanitized audit metadata update only after success; failures return a generic message without endpoint credentials.
- `node control-plane/scripts/test-databases.mjs --target-only` passed against MinIO running in Docker: write/read/compare/delete succeeded, the probe prefix was empty afterward, an unrelated object remained intact, and `lastTestedAt` was set. The runner builds pinned MinIO source into a disposable local image because the previous `minio/minio` image is unavailable.
- The combined `--target` run passed 724/724 control-plane tests, formatter/Oxlint, typecheck/build and `go test ./...`; engine/registry integrations reached 7/8 before the existing private-registry transfer check failed (`Isolated registry image transfer failed`), so the combined command did not reach the MinIO test. The isolated MinIO test passed separately. CLI/UI, backup streaming, backup/restore/PITR/recover and import/export remain unimplemented; no backup acceptance scenario is marked complete.

## 2026-11-17 — Backup target CLI and dashboard

- Added `fleet db targets <project>` and `fleet db target add|assign|test|remove`. Creation accepts access keys through hidden interactive prompts or `FLEET_S3_ACCESS_KEY_ID` and `FLEET_S3_SECRET_ACCESS_KEY`; secrets do not go in arguments or CLI output. Target removal asks before detaching target configuration unless `--yes` is given.
- Added project-scoped target listing and creation to the dashboard with password-masked secret entry, default-target selection, connection testing, and typed-name confirmation before removal. Credential inputs clear after successful creation and API responses contain only public target fields.
- CLI typecheck and **230/230** tests passed. Dashboard typecheck, **32/32** tests and production build passed. The build reports its existing large JavaScript chunk warning. No backup data operation is implemented yet; no backup acceptance scenario is complete.

## 2026-11-17 — Per-database backup target assignment

- Added an authenticated project-scoped assignment route that accepts a target ID or `null`; target IDs must belong to the same fleet and project. Deleted databases cannot change targets. Assignment and detachment are audited, and the database view now reports `backupConfigured` and `backupTargetId` from persisted state. Removing a target continues to detach references through the FK.
- Added dashboard selection on database detail and `fleet db target assign <project> <database> <target|none>`. The control-plane suite passed **724/724** with formatter/Oxlint, typecheck/build and `go test ./...`; CLI typecheck and **230/230** tests passed; dashboard typecheck, **32/32** tests and build passed.
- This only records target selection; no backup bytes are created or streamed yet. Restore/PITR/recover and import/export remain unimplemented, so backup acceptance remains open.

## 2026-11-17 — Durable backup manifest schema

- Added migration 0046 with `database_backups`, backup kind/state enums, object manifest checksums/sizes, generation/engine identity, recovery-point metadata and timestamps. Database references are retained until backup records are explicitly removed; target and node deletion detach metadata without erasing verified backup history.
- `node control-plane/scripts/test-databases.mjs --unit-only` passed: migration applied, **724/724** control-plane tests, Prettier/Oxlint, TypeScript typecheck/build and `go test ./...`. The target test now verifies an existing backup record survives target deletion with target reference cleared.
- This is metadata persistence only. No worker writes a manifest, no database data is uploaded, and no backup/restore/PITR acceptance is complete.

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

## 2026-11-17 — Encrypted logical backup operation

- Added scoped `GET/POST .../databases/:databaseId/backups` routes. Backup creation requires a running database and an assigned project target, is admin-authorized and idempotent, and creates the operation and manifest atomically. The worker claims the durable backup lease and resumes the same backup identity after a restart or lost reply.
- Postgres uses `pg_dump` custom format; durable Redis uses `redis-cli --rdb`. Both stream through the negotiated database tunnel, receive AES-256-GCM encryption in the control plane, and upload through backpressured 8 MiB S3 multipart chunks. A read-back checksum is required before the manifest is marked complete. Keys are derived from the existing master secret and backup ID; only the nonce and format are stored alongside the manifest.
- Verification: **724/724** control-plane tests, formatter/Oxlint and TypeScript typecheck/build passed; `go test ./...` passed; `node control-plane/scripts/test-databases.mjs --worker-only --backup` passed the **1/1 real two-agent Docker test**. It creates actual Postgres and Redis backups in disposable MinIO, verifies the stored checksum, decrypts each artifact and checks its format, and confirms temporary Redis files are removed. The 2 MiB tunnel run at 100 ms RTT completed in about 2.86 s against the 12.8 s stop-and-wait lower bound.
- This implements manual logical/RDB snapshots and engine-level WAL archiving/fetch, but not a Fleet-managed recoverable base/WAL manifest. PITR, restore/recover, retention/delete, import/export, and backup controls in CLI/dashboard remain open. No production access, Raunak data, publishing or merge was used; PR #36 remains unmerged.

## 2026-11-17 — Manual database backup CLI and dashboard

- Added `fleet db backup <database>` and `fleet db backups <database>`. Creation sends an idempotency key, follows durable operation progress by default, and displays persisted state, size, creation time and verification. Legacy service `fleet backup` is unchanged.
- Added a database detail backup panel with manifest state, byte size, age and safe error code. Admins/owners can request a snapshot only while the database is available, not already operating, and has an assigned target. The UI follows operation progress and refreshes persisted manifests. PITR and restore are labeled unavailable.
- CLI typecheck and **231/231 tests** passed; dashboard typecheck, **32/32 tests** and build passed (existing Vite chunk-size warning). `node control-plane/scripts/test-databases.mjs --unit-only` and `go test ./...` passed for the full milestone gate. Formatter/lint and Graphify were refreshed. WAL/PITR, restore/recover and real browser acceptance remain open.
- Next: Fleet-managed base backup manifests and restore/PITR, then end-to-end recovery proofs. No production access, Raunak data, publishing or merge was used; PR #36 remains unmerged.
- UI copy states verification only after object read-back and checksum, without calling Redis RDB artifacts logical backups.

## 2026-11-17 — Portable database dump export

- Added `fleet db dump <database> <file>`. Postgres emits a standard custom `pg_dump` archive; durable Redis emits an RDB snapshot. The control plane uses the owner role only for this admin-authorized export mode, rejects Redis cache mode, writes a durable audit event without credentials, and streams bytes through the existing bounded tunnel. CLI output is created with mode 0600 and exclusive-create semantics; interrupted writes are removed when the process handles the failure.
- The real Docker/two-agent tunnel test drove both CLI exports end to end, verified `PGDMP` and `REDIS` signatures, checked private file permissions, and confirmed an existing file is not overwritten. The same run retained the 2 MiB/100 ms RTT result (about 2.85 s versus a 12.8 s stop-and-wait minimum).
- CLI **231/231 tests** and typecheck passed. `node control-plane/scripts/test-databases.mjs --unit-only` passed **724/724 control-plane tests**, pinned Prettier/Oxlint, typecheck/build, and `go test ./...`. `--worker-only` passed the real Docker transfer. Graphify refreshed. Fleet-managed base/WAL manifests, import, PITR, restore/recover and browser download remain open.
- Next: schedule Fleet base backups and persist the recoverable WAL chain independently of target credentials, then prove timestamp restore into a new database against real Docker/MinIO. No production access, Raunak data, publishing or merge was used; PR #36 remains unmerged.

## 2026-11-17 — Apply changed backup configuration on restart

- Start/restart intents now include the server-generated engine container plan. The agent safely replaces only its owned stopped container when the configuration hash changes, removes only owned obsolete config volumes, and reuses the existing data volume without initialization. The worker intent validator now accepts both image digest forms already supported by the agent.
- The real two-agent Docker test assigns a target, restarts the database through the API/worker/agent, verifies active WAL-G Postgres settings and all three secret files at mode 0600, then completes encrypted Postgres/Redis backup and MinIO checks. It passed with the operation asserted successful; the 2 MiB transfer at 100 ms RTT completed in about 2.84 s versus 12.8 s stop-and-wait minimum.
- Verification: full control-plane suite **726/726**, formatter, Oxlint, TypeScript typecheck/build, `go test ./...`, and `node scripts/test-databases.mjs --worker-only --backup` passed. Graphify refreshed to 4,553 nodes / 11,866 edges.
- Archive settings take effect after restart. Fleet-managed base/WAL manifests, PITR and restore/recover remain open; no product acceptance is claimed for those flows. No production or Raunak data was used, and PR #36 remains unmerged.

## 2026-11-17 — Download verified logical backups

- Added an owner/admin-only API download that streams the encrypted S3 object through AES-GCM decryption, checks the stored size and SHA-256 manifest and authenticates the GCM tag before the stream completes. Downloads are audited. `fleet db backup download <db> <backup-id> <file>` writes an exclusive mode-0600 file and removes partial output on transfer errors.
- Real Docker/API/MinIO validation downloaded a Postgres backup and compared the result byte-for-byte with direct decryption of the encrypted object. CLI tests verify the file bytes and mode. This downloads logical/RDB artifacts; Fleet restore, point-in-time recovery, import and target-independent access after target deletion remain outstanding.
- Verification: control-plane **726/726**, Prettier/Oxlint, typecheck/build, `go test ./...`, real tunnel + MinIO backup/download/WAL-G Docker tests, and CLI **232/232** with typecheck passed. Graphify refreshed to 4,554 nodes / 11,875 edges.

## 2026-11-17 — Real WAL-G point-in-time restore proof

- Extended the disposable Docker/MinIO test to execute the Postgres engine's restore plan: fetch an encrypted base into a new volume, replay encrypted WAL to a timestamp, promote, and verify a row inserted before the target exists while a later deletion does not. The archive segment and encrypted WAL were fetched and validated with `pg_waldump`.
- `node scripts/test-databases.mjs --worker-only --backup` passed the real two-agent transfer/backup scenario and the WAL-G/PITR restore. This proves the engine-level WAL-G path only; no Fleet restore/recover operation, new-database lifecycle, in-place safety copy, CLI/UI wizard, or restore progress workflow is claimed yet.

## 2026-11-17 — Fleet-managed logical PostgreSQL restore

- Added an authenticated, idempotent restore operation from a verified logical backup into a different running PostgreSQL database in the same project. The target is marked `restoring` with the queued lease, receives bounded decrypted backup bytes over the database tunnel, and only completes after `pg_restore --single-transaction` exits successfully. A preflight rejects user relations in the target while ignoring extension-owned relations. Rejected non-empty targets remain running and keep their data intact.
- Real Docker/MinIO API/worker test created a source dump, restored it into a separately provisioned PostgreSQL container on the node, verified the restored row, then proved a second restore into the now-nonempty target fails without changing that row. The fixture also retains the two-agent 2 MiB transfer at 100 ms RTT (about 2.85 s versus a 12.8 s stop-and-wait lower bound) and WAL-G/PITR Docker test.
- Full verification: **726/726 control-plane tests**, Prettier/Oxlint, TypeScript typecheck/build, `go test ./...`, and `node scripts/test-databases.mjs --worker --backup`. Graphify refreshed to 4,560 nodes / 11,892 edges.
- This covers the Fleet-managed logical PostgreSQL restore slice only. The CLI restore flow, dashboard controls, Redis RDB restore, WAL-G base/time/named PITR through the Fleet worker, in-place safety copies, `recover`, import, retention and V1 acceptance remain open. No production access, Raunak data, publishing or merge was used; PR #36 remains unmerged.

## 2026-11-17 — CLI logical restore command

- Added `fleet db restore <source-database> <backup-id> --into <empty-target>`. It accepts a full or unique backup ID prefix, requires a verified logical PostgreSQL backup and a separate running PostgreSQL target of the same major version, submits an idempotent restore operation and follows durable progress by default. `--no-wait` and `--json` return the queued operation. The existing safe target check rejects a populated database without replacing its contents.
- CLI `npm run typecheck && npm test` passed **233/233**. The Fleet-managed restore API/worker integration remains covered by the full control-plane + real Docker/MinIO run recorded above.
- The CLI currently requires the user to create an empty target first with `fleet db create`; it does not infer or create a second database. Dashboard restore controls, Redis RDB, WAL-G PITR worker flow, in-place safety copies, recover, import and overall V1 acceptance remain open.

## 2026-11-17 — Dashboard logical restore controls

- Database detail now lists running, online PostgreSQL targets in the same project and at the source's major version. Verified logical Postgres backups can be queued into the selected target; the UI navigates to that target so its persisted operation state and SSE progress are visible. Copy states that populated targets are refused and their data is preserved.
- Added a mounted dashboard test for target selection, restore API payload, and navigation to the target operation. Dashboard typecheck, **33/33 tests**, Prettier, and production build passed. Vite retains its existing large-chunk warning.
- The dashboard requires the user to create the empty target separately. Browser/Playwright acceptance, Redis restore, Fleet-managed WAL-G PITR, in-place restore, recovery, import, and full V1 acceptance remain open.

## 2026-11-17 — Typed soft delete and grace restore

- Added owner/admin API routes for typed-name database deletion and restore during a seven-day grace period. Delete requires an engine-matching verified backup created within 15 minutes, queues on the existing durable database operation lease, and removes only owned runtime containers and config volumes. The data volume stays intact. Restore clears deletion markers, returns the row to stopped, and uses the normal lifecycle worker to start it.
- Real Docker/API/worker/agent/MinIO coverage verified the final backup gate, idempotent delete replay, container removal, data-volume retention, grace restore and restart, then queried a row written before deletion. The first run exposed a timestamp precision race; the atomic restore predicate now checks status, non-null deletion time and the database-side grace deadline.
- Verification: `node control-plane/scripts/test-databases.mjs --worker-only --backup` passed the real two-agent tunnel/backup/delete/restore test and WAL-G/MinIO PITR test. `node control-plane/scripts/test-databases.mjs --unit-only` passed **726/726**, Prettier, Oxlint, TypeScript typecheck/build and `go test ./...`. Graphify refreshed to 4,574 nodes / 11,954 edges.
- Automatic grace-period purge, dashboard/CLI delete controls, and Playwright acceptance remain open. No production access or Raunak data was used; PR #36 remains unmerged.

## 2026-11-17 — CLI and dashboard soft delete controls

- Added `fleet db delete <database> --backup <id> --confirm <name>` and `fleet db restore-deleted <database>`. CLI deletion resolves a unique verified backup of the correct engine, requires its creation and verification timestamps within 15 minutes, and submits the exact database name. The recovery command restores the row stopped so the normal `fleet db start` can resume it.
- Database detail now offers deletion only to owners/admins, only while stopped/running and online, and only after selecting a matching recent verified backup. Confirmation requires typing the database name. During the seven-day period, the dashboard hides runtime mutation and link controls and offers a recovery action with the deadline.
- CLI Prettier, TypeScript typecheck and **234/234 tests** passed. Dashboard Prettier, TypeScript typecheck, **34/34 tests** and production build passed (existing Vite large-chunk warning). No Playwright browser flow was run.
- Automatic grace-period purge and broader V1 UI acceptance remain open. PR #36 remains unmerged; no production access or Raunak data was used.
