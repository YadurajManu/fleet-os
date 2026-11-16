# Fleet Databases design

Status: implementation contract, not a shipped feature list. Based on [the observed system](00-understanding.md). V1 must pass every acceptance scenario in REQUEST.md before V2 starts. Preserve existing agents, services, manifests and volume backups; never operate on Raunak or the control plane's own databases as tenant resources.

## Resource and schema decisions

Use dedicated `tenant_databases`, not a service with an engine label. It belongs to a fleet and a project string, matching existing tenancy. Keep UUID identity stable across names, operations, volumes and recovery.

| Table | Required data and constraints |
| --- | --- |
| tenant_databases | UUID, fleet FK, project/name, engine/version/mode, desired state, observed status, pinned node FK (restrict removal while data is attached), volume identity, memory/CPU/disk reservations, tuning profile/allowlisted overrides, backup-target reference, generation, created/updated/deleted/purge timestamps. Unique live fleet/project/name; retain identity during grace. |
| database_credentials | Database FK, role, encrypted envelope, active generation and transition timestamps. Never included in resource serializers. |
| database_links | Database FK, service FK, role, explicit env-key mapping, applied generation and restart-required state. Unique service/environment ownership. Verify matching fleet/project transactionally. |
| database_operations | UUID, database FK, fleet/project scope, kind, idempotency key, input fingerprint, state, checkpoint, generation, lease token/expiry, bounded attempts, progress, safe error code, timestamps. Unique scoped idempotency key; partial unique active mutating operation per database. |
| database_operation_events | Operation FK, monotonic identity cursor, level/code/safe message, progress, timestamp. Index operation/cursor for SSE replay. No raw secret-bearing arguments/output. |
| database_backup_targets | Fleet/project or explicitly authorized global scope, S3 endpoint/bucket/prefix/region, encrypted credentials and encryption-key envelope, connectivity-test result, default flag, retention policy. |
| database_backups | Database/target/node, engine/version, type, object manifest/checksums, encryption-key version, size, start/end, verified time, LSN/timeline/WAL coverage, labels and restore point, operation FK. Failed attempts remain visible. |
| database_migration_runs | Database/deploy/operation, tool, sanitized command description, status/timing, direct role reference, restore-point FK and log cursor. |
| database_metric_rollups | Database, bucket timestamp/interval and typed aggregate; unique database/bucket/interval. |
| database_alert_instances | Rule/database key, open/recovered state, first/last seen and delivery deduplication. Reuse existing channels and audit log. |

Use database enums/check constraints for finite states and positive resource limits. Start/stop intent is separate from observed health. Observed statuses: provisioning, running, stopped, unreachable, degraded, restoring, failed, deleting. Soft deletion retains volumes/credentials/backups for seven days; final backup must succeed before deletion proceeds. Purge is its own idempotent operation. Cascades must not allow node removal or a service delete to silently delete database data. Existing fleet/account deletion paths need a database-aware safety gate before resources become creatable.

Reject retrofitting `services`: app rolling replacement/failover semantics are unsafe for volumes. Reject a new project table in this change: current ownership is fleet plus project string and a partial migration creates two conflicting authorization models.

## Engine contract and images

One typed plugin contract covers supported versions/platforms, maintained image, data directory/ports, role and credential generation, config generation/validation, readiness and health, backup/restore/export/import descriptors, metric parser, tuning and extensions. Implement Postgres 16/17 and Redis 7 first. Descriptors contain secret references; runtime mounts or injects secrets through Docker API without putting passwords in host process arguments. Unknown versions/config keys are rejected. Legacy `manifest/databases.ts` remains explicitly legacy until migration support exists.

Fleet Postgres images use official Debian Postgres multi-arch bases, a pinned WAL-G release verified by checksum, pgvector and the curated built-in extensions, and `pg_stat_statements` preload. Build amd64/arm64 with native builders; record registry digests and verify extension availability in both images before release. No advertised extension can be absent from the image. PgBouncer is a separate private sidecar in transaction mode; direct owner endpoint is for administration/migrations. Pool limits and Postgres memory config are derived together. Prepull only images from the signed/digest-pinned catalog during idle time and account for disk reserve.

Reject stock Postgres plus installing extensions on startup: slow, network dependent, unrepeatable. Reject embedding PgBouncer into the Postgres process supervisor: separate health and resource controls are clearer. No private-registry image URL is considered usable until push/pull verification.

Postgres roles: owner owns schema/migrations, app gets DML/sequence access and default privileges, readonly gets SELECT; all use SCRAM. Tuning budgets include sidecar memory, connection/backend costs, work_mem concurrency and maintenance. Profiles dev/standard/performance choose conservative limits; expose actual config and restart impact. Overrides accept only documented safe keys, bounds and units, never file paths/shared libraries/command hooks.

Redis cache sets no persistence, bounded maxmemory and allkeys-lru. Durable uses AOF, noeviction and scheduled RDB snapshots; UI explicitly explains write errors at memory exhaustion. ACL users enforce app/readonly separation; credentials are mounted as a protected config/ACL file, not command arguments. Never reuse the legacy unauthenticated Redis behavior for new resources.

## Durable operation execution

States: queued -> running -> succeeded/failed/cancelled; running with an expired lease -> reconciling -> running or failed. Persist intent before contacting the agent. Claim with row locking/skip-locked, a random lease token and bounded expiry; mutations and results require matching lease/generation. Renew during long work. A unique active-operation constraint serializes conflicting work. An idempotency key reused with different validated input returns conflict, not the previous operation.

Every runtime step has a durable checkpoint and deterministic resource identifiers: inspect volume/container before create, inspect backup manifest before upload commit, never repeat destructive restore/promotion based only on a lost response. Agent receipts record completed generation/step. After restart, reconcile physical state against intent; uncertain destructive steps fail visibly with recovery instructions. Retries use bounded backoff for transient transport failures, not blind SQL/restore retries. Progress/events persist in the same transaction as state changes. Redis publishes a wakeup only; Postgres is authoritative.

Reuse SSE response/auth patterns but seed/replay from durable event cursors with Last-Event-ID, bounded pages and periodic session/membership revalidation. Reconnect cannot miss events between snapshot and subscription. Redact before persistence. Generic internal exceptions map to safe error codes; raw runtime output gets credential-aware scrubbing and bounded retention. Operation output is never a credential reveal channel.

Reject in-memory promises as the operation queue: a restart loses them. Reject Redis-only jobs without a persisted execution record: observability and recovery would disagree. Existing deployment promises stay for apps; the new database worker is durable.

## Stateful scheduler and runtime

Add an explicit workload class for databases and reserve RAM/CPU/disk even while stopped or unreachable. Initial placement filters supported database capabilities, engine platform, live tunnel, Docker free disk with safety reserve and memory. Reuse weighted ranking and add measured uptime/flap scoring; unknown history is shown as unknown, not stable. Surface recommendation components and SD-card/unstable-node warnings. Project links provide soft affinity for app placement; never reuse existing hard `affinity` semantics.

Pin a created volume to node identity. Offline means unreachable and alerts, no replacement volume, no automatic database move. User-directed recover selects backup/WAL coverage and an eligible destination, displays measured RPO, creates a new volume and validates it before updating link generations. Returning old nodes cannot serve a recovered generation. Retain old copies until explicit disposal/TTL. Unknown disk capacity makes a node ineligible rather than assuming space.

Dedicated Go database reconciler owns labeled database containers, project networks, volume and PgBouncer. It does not pass database containers through the app reconciler's rolling replacement. Stop/restart and health/readiness use engine-specific commands through Docker exec. API failures never remove a volume. Named volumes work on Windows Docker Desktop; paths are container paths. Docker VM disk reporting must use engine data, not the Windows/macOS host volume.

## Network and capability negotiation

Project network name is derived from fleet/project identity, bounded by Docker constraints; stable DNS aliases include `<database>.fleet.internal` and pooled/direct service names. DB containers have no published ports. Link generation connects app containers only to authorized project networks.

Extend the authenticated tunnel with additive TCP open/opened/data/window/end/close frames, unique stream IDs, bounded chunks and outstanding bytes, explicit half-close, deadlines and per-node/user limits. Agent targets are database IDs plus approved ports resolved from local managed runtime state; never accept arbitrary host/port targets. Track stream ownership by node/socket epoch so reconnect cannot splice old and new sessions. Disconnect closes local sockets; no replay of SQL bytes. Control plane relays cross-node streams; a per-node project connector exposes stable local DNS targets. Show added RTT and control-plane relay dependency on links placed remotely.

`db connect` binds localhost only (IPv4/IPv6 handled explicitly), requests a short-lived database/role-scoped random token stored hashed, and transports through an authenticated WebSocket. Check membership and token revocation at open and periodically during a stream; revocation closes active streams. No token in query-string/access logs. Direct database protocol remains intact for psql/Prisma Studio. CLI never exposes a remote port or silently binds 0.0.0.0.

Capabilities are additive versioned flags for stateful runtime, TCP streams, engine exec/PTY, streamed backups and metrics. Missing fields mean unsupported. Server advertises only enabled features; agent advertises only implemented handlers. Do not infer from semver. Older v0.2.4 agents retain HTTP/app behavior and receive no unsupported frames. Placement errors say agent upgrade required with the appropriate command. Stamp the next agent release only after handlers and old-agent tests pass.

## Backups, restore and safety

WAL-G streams encrypted Postgres base backups and continuous WAL to an S3-compatible target. Encryption key is independent of storage credentials, sealed with the existing envelope primitive; clients receive only scoped short-lived access where supported. Plaintext keys are mounted with restrictive permissions. Never stage an entire dump/base backup on database disk. Retention defaults to seven daily/four weekly bases and retains all WAL needed by every retained base/restore point. Prune only after a newer verified recovery chain exists. Interrupted uploads never become complete manifests.

Target test validates write/read/delete of a unique test prefix, TLS, permissions and engine reachability; it must not list/delete unrelated objects. Without a target, creation works with persistent no-off-node-backup warning and no claimed RPO. RPO is now minus last confirmed recoverable WAL, not last job-start time. Report unknown or broken continuity honestly. Durable Redis uses engine-generated RDB streamed to encrypted object storage; do not tar a changing data directory.

Restore defaults to a new resource. Accept backup ID, latest, validated timestamp or named restore point and check coverage/timeline/version/keys before scheduling. In-place restore requires typed name and explicit impact, stops writers, renames/retains old volume and checks capacity for both. Restore into a fresh volume, validate readiness/integrity, then atomically adopt generation; failure leaves the old copy intact. Recovery to another node follows the same path then reapplies links and rolls apps. Deleted resources remain recoverable during grace.

Exports are standard pg_dump custom archives or Redis RDB, streamed and downloadable by authorized users. Imports target new/empty databases only, perform connectivity/version/size checks and run from the node. URLs are encrypted input, never logged/returned. No host process args contain credentials. Offline backup storage is an explicit failure, not a successful local-only backup.

## Deployment release phase and declarative config

Run the shared gate after an immutable app image exists and before any old-release supersession/traffic switch, across local/manual/webhook paths. Resolve Prisma/Drizzle detection deterministically or honor explicit custom commands. Create an off-node recoverable pre-migration restore point and record LSN/time first. A one-off container runs on the database network using the direct owner URL through secret injection, with resource reservation, deadline, streamed/redacted logs and cleanup. Advisory locking must be held on a dedicated database session throughout the migration process; serializing API calls is insufficient. Serialize multiple DB locks by UUID to avoid deadlocks.

Failure aborts deployment before traffic changes, leaves old app serving and records exact run/restore command. Successful schema changes do not imply automatic downgrade on later app failure; document backward-compatible migration requirements. Manual migrate/exec/shell/seed use the same authorization, audit, timeout, agent execution and secret paths; interactive shell executes psql/redis-cli in the container using the existing PTY infrastructure extended to container exec.

Preserve old `databases:` semantics for existing resources. New declarations need an explicit schema-version marker and migration/adoption workflow with preflight; no automatic conversion of existing volumes. New-format apply creates missing resources/links idempotently and waits for readiness before dependent release phases. Changed declarations cannot delete/shrink/downgrade; reject with an explicit CLI action. An engine previously supported by legacy manifests continues there until its new plugin is delivered.

## Metrics, alerts, API, CLI and dashboard

Collect typed engine metrics at a conservative default 30 seconds with jitter and bounded time/output. Postgres uses pg_stat views/pg_stat_statements with a monitoring role; Redis INFO/SLOWLOG with a constrained ACL. Include real container usage and volume disk growth. Query samples may contain literals: normalize/redact and gate access. Store recent samples in Redis with a 24-hour TTL; persist five-minute rollups for 30 days and hourly for 365 days with bounded janitor work. Timestamp cursors, enforced range/point caps and server downsampling prevent unbounded chart loads. Missing samples are gaps.

Evaluate offline, unreachable, backup stale/failure, WAL failure/lag, connections, memory and disk 80/90% rules. Persist dedup/recovery state and use existing webhook/email/Slack/Discord dispatch; per-DB overrides inherit defaults. Never put credentials/query text in alerts. Existing audit log records every mutation/reveal/access session.

API prefix `/fleets/:fleetId/projects/:project/databases`, plus scoped target endpoints. Collection/create, detail, lifecycle, links, credentials/reveal/rotate, backup/restore/recover/import/export, extensions/tuning, metrics/schema/migrations/alerts, operation history and SSE all authorize fleet/project before lookup. Creation/action returns 202 and operation location. Lists are cursor-paginated. No empty-success stub for an unsupported action. Separate permissions for reading metadata, operating, reveal/exec, restore/delete and target administration, mapped explicitly onto existing roles.

CLI adds the full `db` and `backup-target` groups from REQUEST.md with shared help, parser, JSON/exit codes, prompts and output. Resource selection includes fleet/project and never picks the first ambiguous name. Progress follows operation SSE and can resume after disconnect. Destructive flows require typed name even in scripted mode through an explicit matching confirmation flag. Shell and binary dump have defined incompatibilities with JSON; fail clearly instead of corrupting output.

Dashboard adds real project/global lists, create wizard, database detail tabs and backup targets in the existing shell/design system. Build each milestone's UI immediately after its API. Show only implemented actions, real empty/loading/error states, keyboard-accessible forms, live operation progress and RPO/no-backup banners. Detail includes overview, metrics, backups/restore/recover, migrations, links, schema, logs, settings and activity. Project/service/deploy/node pages receive database integration as those APIs arrive. No random charts or future-feature buttons.

## Failure behavior

| Failure | Detection and visible state | Automatic action | Manual recovery |
| --- | --- | --- | --- |
| Node offline | Heartbeat threshold plus restart grace; unreachable, last data location/RPO | Alert; preserve pin/reservations; no new empty DB | Recover from measured backup coverage on eligible node |
| Agent crash | Heartbeat/tunnel loss; operation reconciling | Reconnect and inspect deterministic runtime state | Restart/upgrade agent; inspect operation |
| Tunnel drop | WebSocket heartbeat/deadline; access stream disconnect | Close streams, retry only safe operation checkpoints | Reconnect client; inspect transaction outcome before retry |
| Disk full | Docker-volume free disk/engine errors; degraded and alert | Stop new heavy work/backups that need unsafe local space; preserve data | Free unrelated data safely or explicit move/resize |
| Backup target unreachable | Upload/test failure; backup failed/stale | Bounded retry/backoff, preserve retained chains | Repair credentials/network and retry backup |
| WAL archive failing | Engine archiver metrics plus object coverage | Critical alert, widening RPO; never claim PITR | Repair target/key, verify continuous coverage/base backup |
| Control-plane restart mid-operation | Expired lease/checkpoint | Reconcile node receipt/physical state; no blind destructive replay | Inspect failed/uncertain step and retained copies |
| Restore failure midway | Runtime/integrity failure | Keep old volume and incomplete new volume isolated | Retry into fresh volume or restore old generation |
| Migration failure/timeout | Process exit/deadline; persisted run failed | Abort release, retain old app and restore point | Fix migration or use displayed restore command |
| Concurrent deploys | Database advisory lock and operation constraints | Wait boundedly; do not double-migrate | Inspect owner run and retry deploy |
| Lease lost/stale agent reply | Lease token/generation mismatch | Reject result, reconcile current generation | Inspect operation if runtime state uncertain |

## V2 decisions and release gates

After V1 acceptance: add replication slots/base-backup bootstrap with measured lag; manual promotion requires verified fencing of the old generation before links switch. An unreachable primary is not proof of fencing. Automatic failover stays opt-in and refuses promotion if it cannot prove fencing, acceptable lag, witness health, grace and flap limits. The single control plane is a limited witness; it cannot guarantee availability during all partitions. Chaos tests must demonstrate refusal as well as successful safe promotion and restart recovery. Rejoin uses pg_rewind only when prerequisites hold, otherwise fresh replica bootstrap; Redis replication/manual promotion follows the same generation rules.

Restore-based branches track parent/restore point/TTL and are isolated resources. Masked clones run reviewed column rules only on the clone. Scheduled restore drills use disposable volumes with integrity checks and durable reports. SQL console/table browser uses readonly default, explicit write mode, transaction/statement limits, bounded results and audit/query history. Insights are measured rule-based recommendations with evidence; disk forecast reports confidence and missing history.

Move prefers replica cutover, otherwise backup/restore with measured outage. Resize retunes within capacity and uses explicit storage workflows. Major upgrades rehearse on a branch and retain rollback volumes/backups. Rotation uses overlapping roles until all link generations roll. Grants are hashed/scoped/expiring and actively revoke sessions. RBAC expands existing role permissions. Optional public access requires separately evaluated TLS termination/TCP routing and IP allowlisting; no public default. Additional targets/channels/engines integrate through tested adapters, not option labels with no behavior. Maintenance windows defer disruptive operations but never hide failed backups/security revocation.

Testing gates: plugin/config/state-machine units; real Docker engine/backup/PITR/import/export tests; disposable local API+agent+CLI E2E; dashboard component tests plus Playwright create/link/backup/both-restore/delete; old-agent protocol/regression tests; leak tests for logs/errors/API/process args; real multi-arch image validation and explicit Windows results. V2 adds partition/crash/fencing/promotion chaos coverage. Track each REQUEST.md acceptance scenario in BUILD-NOTES; do not call either version complete with missing evidence. Open V1 PR only after its gate, then branch feat/db-v2 and open an unmerged V2 PR after its gate. Do not publish npm or run Raunak migration.
