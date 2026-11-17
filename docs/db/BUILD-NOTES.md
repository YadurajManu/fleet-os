# Fleet Databases build notes

## 2026-11-16 — Autonomous continuation, engine milestone started

- CONTINUATION.md records the updated execution rules; PROGRESS.md tracks every milestone and acceptance scenario without upgrading component evidence to E2E proof.
- Pinned official base-image indexes, WAL-G v3.0.9 per-architecture binary hashes, pgvector 0.8.7 commit/archive hash and PgBouncer 1.26.1 source hash from upstream release metadata. Recipes compile portable pgvector and verify downloaded artifacts before installation. Builds use a disposable named Buildx builder and local image/OCI output only.
- Safe interpretation of registry restriction: no remote registry/image/release-channel publication. An isolated localhost registry may be used solely for real integration tests and removed afterwards; release registry transfer remains prohibited.
- Existing untracked workspace files remain untouched. GitHub origin and the active YadurajManu GitHub credentials are available; branch pushes are authorized, merges and releases are not.
- Engine plugin contract now generates private container/file plans, independent credentials, default privileges/ACLs, pooled/direct URLs, readiness, engine backup/recovery/export commands and bounded metric parsing. Images must be digest pinned; registry resolution reuses existing credential-safe inspection and never falls back to an unverified tag/platform. Secret material stays in protected files, stdin or Docker exec environment, not process arguments.
- Added disk-budgeted cached/pinned image pre-pull in the agent Docker package; capability advertisement remains off until actual runtime handlers are installed. Unit checks: six engine/catalog tests, API typecheck and Go Docker tests passed. Real maintained-image tests are written and await the ongoing build; no milestone/E2E completion claim.
- Native build friction: PG development-package dependencies include substantial compiler/LLVM downloads. The build is live, with no feature substitution; unrelated fixture/contract work proceeds while it runs. Buildx owns a uniquely named disposable builder so cleanup never prunes another project's cache.
- Resolved build issues: CA certificates must be installed before using HTTPS package sources; compile pgvector with extracted server headers and `with_llvm=no` to avoid unnecessary LLVM build dependencies. Compile only the PgBouncer binary so image construction does not require the documentation generator. WAL-G is checksum-verified in a reusable build stage. Native Postgres 16/17, PgBouncer and Redis images now build successfully.
- Added a Postgres entrypoint wrapper that reads the mounted owner-password file for the upstream initializer's local SCRAM connections. Owner credentials do not enter Docker process arguments or image layers.
- Real maintained-image integration: 3/3 passed, including Go Docker resource creation and clean lifecycle, project-private network/ports, app/readonly privileges, pooler transactions, curated extensions, metrics and portable dump round trip. Resource helpers reject missing data volumes unless initialization was explicitly requested; app reconciliation labels are deliberately absent from these containers.
- Go exec now streams Docker's multiplexed output over an authenticated local Engine connection, supports PTY resize and enforces ownership/generation plus execution deadlines. App/readonly clients use separate unprivileged OS identities because interactive psql shell escapes must not read the owner's password file. HTTP/stream unit tests passed; Go readiness exec is exercised by real engine tests. Full tunnel/PTY handler wiring, immediate session cancellation and runtime capability advertisement remain pending.
- Docker Desktop loopback differs between the host and Engine VM. Rather than alter insecure-registry settings or expose LAN ports, registry integration uses a pinned, disposable Docker-in-Docker/registry fixture with loopback-only published ports, labeled volumes and no host Docker socket. Its real authentication/digest/platform/pre-pull test passed 1/1; fixture containers/volumes were removed.
- The shared registry helper now seeds its disposable config's auth map to avoid Docker silently selecting a host keychain helper. This keeps registry-login secrets in the temporary config that is removed afterwards.
- Build cache is retained only in the named Fleet Databases builder while native/multi-arch verification is active. Its ownership record lives under ignored `.build/`; cleanup validates the builder label and does not prune shared/default Docker caches. Full native regression gate and dual-architecture OCI build are in flight; no user-facing acceptance scenario has been marked verified.

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

## 2026-11-16 — Engine milestone verified; stateful runtime started

- Final milestone command `node control-plane/scripts/test-databases.mjs`: 703/703 control-plane tests, typecheck/build, all Go packages and 8/8 real Docker checks passed. The isolated authenticated registry verifies both architectures resolve to the same immutable index; the real agent checks disk reservation, pulls the index and subsequently uses its cache without credentials.
- Dual-platform OCI builds completed for Postgres 16/17, PgBouncer and Redis. `verify-oci.py` traversed indexes/manifests/configs/layers, validated every SHA-256 and checked arm64/amd64 configurations/labels. Archives were imported locally and removed after verification to conserve disk. No external registry was published.
- All three maintained engine tests also passed under amd64 emulation (Postgres 16, Postgres 17 and Redis). Native runtime coverage remains Linux arm64 through Docker Desktop. Agent cross-compilation passed Linux arm64/amd64, Windows amd64 and Darwin arm64; these builds are not hardware tests.
- A real disk guard initially refused image pre-pull when host disk free space was below its automatic reserve. Only this task's uniquely recorded builder/cache and checked OCI scratch archives were removed, recovering headroom. The original Buildx container did not carry the assumed Buildx ownership label: its exact workspace record, container identity and state-volume mapping established ownership for cleanup. Future builders use a pinned labeled BuildKit wrapper and precreated labeled state volume; cleanup checks the label and identity. No shared/default cache was pruned.
- Docker's platform-specific image-inspect ID can be a config digest that is not a creatable image reference. After importing OCI indexes, tests failed rather than silently using another architecture. The test now passes the immutable index ID with an explicit platform to both config writer and engine creation; both architectures pass.
- Starting milestone 2 with durable receipts containing only identity, generation, operation fingerprint and checkpoints. Plans/passwords are not persisted locally. Restart resume records the clean-stop checkpoint before starting, and refuses changed inputs, stale/cross-node identities, corrupt receipts and replacement operations over uncertain work. Higher generations require an explicit fenced recovery workflow, never automatic relabeling.
- The stdio/TCP helper is needed because Mac/Windows hosts cannot directly dial Docker bridge addresses and database ports must remain unpublished. It only dials the engine's loopback database port inside its container. Binary half-close behavior passes a real local TCP test; image/tunnel wiring and real database proxy tests are next. Capabilities stay off until implemented and verified.

## 2026-11-16 — User-authorized foundations merge

- The user explicitly requested merging the committed PR to main before continuing. This supersedes the previous no-merge instruction for this foundations PR. Created and merged PR #35 (https://github.com/YadurajManu/fleet-os/pull/35), merge revision `55420b4`, containing committed work through `19d4d8e`; unfinished runtime work was excluded and preserved locally. Continued feat/db-v1 from the merged revision.
- GitHub checks passed for control-plane (including migration/typecheck/tests), agent (vet/tests/all configured cross-target builds), CLI, dashboard, Windows installer, ingress, upgrade script and Snyk. Marketing failed its npm audit on three high-severity dependency findings; the identical failure exists in main CI run 43665607866 and no www files were changed by this PR. Merged without overriding branch protections or altering that unrelated baseline. No deployment/publishing workflow exists in this repository CI, and no production action was taken.
- This was a foundations milestone PR, not V1 completion. V1 acceptance and V2 remain outstanding; final product PRs still require their complete gates.

## 2026-11-17 — Credit window protocol

- Working on feat/db-v1-runtime from merged main. No further merges are authorized.
- Stream open requests offer 16 credits; the peer explicitly selects 16 in its opened response. Missing negotiation retains one frame. Each ordered acknowledgement returns exactly one credit. The sender waits for all outstanding credits before completing a write, preserving EOF ordering.
- Receiver buffering is bounded by its 64 KiB drain threshold plus the 16 outstanding 32 KiB frames. Invalid sequence, oversized frames and invalid acknowledgements close the stream. Credits held behind slow stdout are also held for subsequent stderr, preserving acknowledgement order.
- Added protocol unit tests and a measured 2 MiB/100 ms RTT comparison (6.47s versus 0.41s). Real Docker two-node and reconnect evidence remains a separate gate before capability advertisement.
- The repository has no configured formatter/linter. Use Prettier with existing single-quote/no-semicolon conventions and pinned Oxlint 1.57.0 for these files at each milestone, alongside tsc and Go checks. Both tools passed for the relay and tests.

Verification for protocol commit: full control-plane suite **711/711 passed**, typecheck/build passed, `go test ./...` passed. The repeatable disposable-dependency command is `node control-plane/scripts/test-databases.mjs --unit-only` (excludes maintained-image/registry integration, which remains a separate gate). Focused protocol tests **8/8 passed**; Oxlint 1.57.0 reports zero warnings/errors.

## 2026-11-17 — Agent commit 2 of 4

Matching Go stream negotiation selects 16 frames only when requested, otherwise one. Input queues and unconsumed-frame counts are bounded; output waits when credit is exhausted and drains acknowledgements before closing. Go tests cover both windows, invalid frames, exhausted credit and cancellation. `go test ./...`, `go vet ./...` and `go test -race ./internal/database ./internal/dbproxy ./internal/docker` passed. Stateful runtime receipts, client process cancellation and the private container TCP helper are included as handler prerequisites; capabilities remain disabled.

A fresh Docker Desktop session has no maintained runtime images. Re-running the Docker runtime tests failed during image lookup, before runtime creation; rebuilding the pinned local images is in progress. Build utility now restores its pinned BuildKit wrapper image even when the saved builder metadata survives an empty image store. No new Docker/two-node verification is claimed by this commit. Previous runtime-only Docker evidence is recorded above.
