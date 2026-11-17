# Fleet Databases progress

Resume here. Scope: REQUEST.md plus CONTINUATION.md; neither V1 nor V2 is complete. Branch: feat/db-v1-runtime, advanced to main merge `55420b4` after user-authorized foundations PR #35. Status vocabulary: not started / in progress / verified. An acceptance scenario is verified only after its complete end-to-end flow runs; component tests below are explicitly partial evidence.

Foundations PR #35 is merged on explicit user instruction. This does not mark V1 complete; the eventual V1/V2 product PR gates remain unchanged.

## Current work

Continuation milestone 1 is verified: engine contract, maintained images, private registry resolution and agent image pre-pull. Milestone 2 is in progress: durable stateful runtime, exec/PTY and TCP tunnel handlers. Capabilities remain unadvertised until their real handlers pass.

Milestone 1 gate: `node control-plane/scripts/test-databases.mjs` completed with **703/703 control-plane tests**, typecheck, build, `go test ./...`, and **8/8 real Docker checks** passing. The Docker checks cover official engine tuning (4), maintained engine/Go resource lifecycle/roles/pooler/extensions/metrics/export (3), and authenticated dual-architecture registry resolution plus real Go pre-pull/cache/disk guards (1). Disposable test dependencies and registry resources were removed.

Cross-platform evidence: `FLEET_DB_PLATFORMS=linux/arm64,linux/amd64 node deploy/databases/build.mjs` built all four OCI indexes. `python3 deploy/databases/verify-oci.py` verified every referenced blob/checksum and both platform configurations before local Docker import. Checked scratch archives were then removed to recover host disk space; ignored verification metadata remains. `FLEET_DB_TEST_PLATFORM=linux/amd64 node --test --test-concurrency=1 --import tsx tests/database-plugins.docker.ts` passed **3/3** under Docker Desktop emulation. Agent `CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build ./cmd/agent` compiled Linux arm64/amd64, Windows amd64 and Darwin arm64. Native hardware is arm64 only; no native amd64 or Windows runtime coverage is claimed.

Runtime helper work has begun but is not part of milestone 1 completion: private, credential-free receipts and a binary stdio/TCP helper have focused unit coverage. WSS integration, runtime Docker E2E, immediate cancellation, storage/stability reporting and capability advertisement remain pending. No product acceptance scenario is verified.

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
