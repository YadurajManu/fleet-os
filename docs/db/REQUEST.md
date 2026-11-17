# FLEET DATABASES: Codex Build Prompt (v1 + v2)

You are a senior staff engineer extending **Fleet OS** with a new product area: **Fleet Databases**. This is a large, multi-milestone build covering the CLI, the control-plane backend, the Go agent, the scheduler, and the web frontend. Read this whole prompt before touching any code.

---

## 0. Rules of engagement (non-negotiable)

1. **Understand before you build.** Phase 0 (understand the codebase) and Phase 1 (write the design doc) come first and produce real documents. Do not write feature code until both exist.
2. **No dummy anything.** No mock data, no stubbed endpoints, no fake charts, no placeholder buttons, no `TODO` left in shipped paths, no hardcoded demo values, no "coming soon" pages. Every button, command, page, and endpoint must be wired to real behavior and tested. If something genuinely cannot be completed, say so explicitly in the final report. Never fake it.
3. **The repo is the source of truth.** Section 1 describes the architecture as the owner understands it. Where the code disagrees, the code wins. Note every difference in the build notes.
4. **Blast radius.** Work only inside the Fleet OS repositories. Do not touch other projects or directories on any server. Do not run destructive commands against live infrastructure. Do not touch the live `raunak` project or its data. All end-to-end tests use disposable test projects, nodes, and databases.
5. **Do not wait for approval.** Make decisions, record them with rationale in the build notes, and keep going. If a decision is irreversible or destructive and could reasonably go either way, choose the safest option and log it.
6. **Keep notes as you go.** After each milestone, append to `docs/db/BUILD-NOTES.md`: decisions made, assumptions, friction hit, UX problems noticed, ideas, open questions. Be honest and specific.
7. **Backward compatibility.** Existing agents (including v0.2.4), existing CLI commands, existing API routes, and existing deployed projects must keep working. New capabilities are negotiated; old agents get a clear "agent upgrade required" message instead of a crash.
8. **Git workflow.** Branch `feat/db-v1`, then `feat/db-v2` (from v1). Small, well-named commits per logical change. Open PRs, do not merge. Do not publish to npm. Prepare version bumps and release notes only.

---

## 1. What Fleet OS is (verify all of this in the code)

Fleet OS is a Railway-style **git-push deploy platform** whose deploy targets are the owner's own heterogeneous, sometimes-offline hardware (Raspberry Pi, laptop, spare VPS) treated as one pool with automatic placement and failover. It is differentiated from Coolify, Dokploy and CapRover (which assume stable, homogeneous nodes) and from Balena (which assumes identical devices).

Known architecture:
- **CLI**: `fleet` (npm package `@yadurajfleetos/cli`). Git push and a GitHub App also trigger deploys.
- **Control plane** on a VPS: Fastify API, PostgreSQL 16 with Drizzle ORM, Redis 7 (pub/sub and heartbeats), SSE log streaming, Docker Buildx native-arch builds (recently moved onto agents via delegated builds, PR #10), weighted headroom scheduler, Caddy ingress for `*.plastikworld.xyz`, private Docker registry v2.
- **Agents**: written in Go (v0.2.x), running on Mac (arm64), Arch Linux (amd64), Windows (Docker Desktop), and Pi-class hardware. They connect **outbound** to the control plane over WSS reverse tunnels, and traffic is proxied back over the tunnel.
- Existing systems you must reuse rather than reinvent: secrets and encryption, auth, project/service model, scheduler and headroom accounting, SSE log pipeline, Redis heartbeats, the Drizzle migration flow, and the CLI's shared output/formatting helpers.

**Important:** Fleet Databases are *tenant resources*. They are completely separate from the control plane's own Postgres and Redis. Never share, reuse, or touch those.

---

## 2. What we are building, and the real problems people have

**Fleet Databases** lets a user create, link, operate, back up, restore, tune, and eventually replicate and branch databases (Postgres and Redis first) on their own hardware pool, with the same git-push simplicity as apps.

The real problems people face today (build to solve these, not an abstract spec):
- They hand-write `docker-compose` for Postgres or Redis, forget backups, and discover this on the day the data is lost.
- The DB lives on a laptop that goes to sleep or reboots, and the whole app dies. Or an auto-failover brings up an *empty* database.
- Connection strings are copy-pasted into env files, committed by accident, or never rotated.
- Migrations are run by hand from a laptop against production, with no safety net and no record.
- Apps open too many connections, which exhausts Postgres (Prisma, many instances, restarts).
- No visibility: nobody knows which query is slow, how big the DB is, or when the disk will fill.
- Restoring a backup is a panic with no practiced path. Nobody knows what the data-loss window is.
- Staging has no realistic data; testing a risky migration means gambling on prod.
- Postgres on port 5432 is exposed publicly and gets scanned and brute-forced.
- Redis silently loses data (no persistence) or silently evicts keys (wrong policy).
- Moving a DB to a stronger machine, or upgrading Postgres, is a scary manual weekend.
- AI/ML builders need pgvector and other extensions without building custom images.

The three users:
- **Solo dev**: one Pi and one VPS. Wants an app and its DB with two commands.
- **Small startup**: wants Railway-style DBs without the bill, and wants safe migrations and restores.
- **Homelabber**: wants Postgres plus Redis for several side projects, with backups, without hand-writing Compose.

A real first day: `fleet db create postgres` → `fleet db link` → `git push`. The migration runs, the app goes live, backups start automatically, and `fleet db connect` lets them look at the data.

---

## 3. Core design principles

1. **A database is not a service.** State lives on one node's disk. It gets its own workload class: stateful, volume-pinned, never silently rescheduled.
2. **Honest failure model.** Never pretend to be highly available when we are not. The UI and CLI always show: where the data lives, the last backup, the data-loss window (RPO) if the node dies now, and what recovery would do.
3. **Private by default.** No public ports. Access is via the internal network or an authenticated, short-lived tunnel.
4. **Safe and fast by default.** Auto-tuned config, connection pooling, encrypted off-node backups, typed confirmation for destructive actions.
5. **Git-push UX preserved.** Databases belong to a project, are linkable to services, and can be declared in the project config.
6. **Everything is an operation.** Create, backup, restore, migrate, move, upgrade are asynchronous operations that are observable (SSE), idempotent, resumable after a control-plane restart, and logged.
7. **No lock-in.** Anyone can export a standard dump and leave.
8. **Heterogeneous nodes.** Multi-arch images (arm64 and amd64). Windows Docker Desktop must work (named volumes, not bind mounts). Node eligibility accounts for disk, RAM, architecture, and stability.
9. **Never leak secrets.** Credentials never appear in logs, errors, process args, or API responses unless explicitly revealed by an authorized user.

---

## 4. Phase 0: Understand the system (deliverable: `docs/db/00-understanding.md`)

Read the code deeply and write down, with file paths as evidence:
- Component map: CLI, API, scheduler, agent, tunnel, registry, ingress, frontend, shared packages.
- The full life of a deploy, from `git push` to a live URL.
- How the scheduler scores and places workloads, how headroom is calculated, and how failover and rescheduling work today.
- The tunnel protocol: framing, auth, multiplexing, reconnect, and whether it can carry raw TCP streams. How traffic between services and nodes flows today, and how services on different nodes talk to each other.
- The agent: how it starts and manages containers, volumes, networks, restart policy, health checks, versioning, and update flow.
- Secrets and encryption: storage, key handling, injection into containers.
- Auth and permissions model (users, projects, tokens, GitHub App).
- Project config format (the file in the user's repo) and how it's parsed.
- CLI structure: framework, command registration, prompt/flag conventions, `--json`, exit codes, and the current output formatting helpers and style.
- Frontend: whether a web dashboard exists, its stack, routing, state/data-fetching, component library, design tokens, realtime (SSE) usage. If **no web dashboard exists**, pick a stack that fits the repo (TypeScript, matching existing tooling), build only what Fleet Databases needs as the start of one, and document that decision.
- Testing setup, CI, lint/type rules, Drizzle migration workflow, release and versioning flow for CLI and agent.
- Risks and unknowns, and the exact files you expect to change.

## 5. Phase 1: Design doc (deliverable: `docs/db/01-design.md`)

Write a concrete design that resolves every item below, each with rationale and rejected alternatives:
- Data model (Drizzle tables, columns, indexes, state machines for database status and operations).
- Engine plugin interface.
- Operation framework (async jobs, state, retries, resumability, locking, SSE progress).
- Scheduler changes: the stateful workload class, volume affinity, node stability scoring, co-location affinity, headroom accounting for DBs, offline-node policy.
- Networking: same-node (private Docker network with a stable internal hostname), cross-node (TCP stream forwarding over the existing tunnel; protocol changes with backward compatibility), and `db connect` (local port forwarding through the control plane with short-lived tokens).
- Agent protocol additions and capability negotiation, plus the agent version bump.
- Image strategy: a Fleet-maintained, multi-arch Postgres image (official base plus WAL-G, curated extensions, pg_stat_statements) published to the private registry, and Redis. Decide how PgBouncer runs (sidecar) and how images get pre-pulled for fast create.
- Backup architecture (WAL archiving, base backups, encryption, retention, verification) and every restore mode.
- Migration release-phase design (see 6.9), including locking, timeouts, and failure semantics.
- Metrics collection, storage (recent in Redis, rollups in Postgres), retention, and alert evaluation.
- API surface, CLI surface, frontend information architecture.
- Failure-mode table: node offline, agent crash, tunnel drop, disk full, backup target unreachable, WAL archive failing, control-plane restart mid-operation, restore failure midway, migration failure, concurrent deploys. For each: detection, user-visible state, automatic action, manual recovery path.

Then implement. Do not stop after the doc.

---

## 6. V1 SPECIFICATION (build everything below, fully working)

### 6.1 Core concepts
- **Database**: belongs to a project. Has an engine, version, mode, node placement, resources, status, endpoints, credentials, links, backups.
- **Link**: connects a database to a service, injecting connection secrets as env vars.
- **Backup target**: an S3-compatible storage destination (R2, S3, Backblaze B2, MinIO, etc.) with encrypted credentials. Per project or global. Has a connectivity test.
- **Operation**: any long-running action, with state, logs, and progress.

### 6.2 Engine plugin interface
Each engine implements one interface so more engines are configuration, not rewrites: image and versions, config generation, role and secret generation, health check, readiness check, backup method, restore method, metrics collection, tuning profiles, connection-string templates, and extension support. V1 engines: **Postgres** and **Redis**.

### 6.3 Lifecycle
Create, start, stop, restart, status, delete. Delete is a soft-delete with a grace period (default 7 days): take a final backup first, require typing the database name, and allow `restore from deleted` during the grace period. Statuses: provisioning, running, stopped, unreachable, degraded, restoring, failed, deleting.

### 6.4 Placement and scheduler
- New **stateful** workload class. The scheduler must **never** auto-reschedule a stateful workload onto another node when its node goes offline, because that would create an empty database.
- Placement recommendation at create time using headroom, free disk, RAM, architecture, and a **node stability score** (uptime history and flap rate). Show the reasoning ("recommended: vps-1, because stable, 40 GB free, 3 GB spare RAM") and **warn** when the user picks a flaky node (laptop) or an SD-card-backed node.
- **Co-location affinity**: services linked to a database prefer the database's node. This is a soft constraint, and when violated the UI and CLI show the latency implication.
- Headroom accounting reserves the database's memory and disk.
- **Offline policy**: node offline → status `unreachable` → alert → linked services keep retrying → no automatic data moves. The explicit recovery path is `fleet db recover` (6.8).

### 6.5 Networking, linking, env injection
- Same-node: a per-project private Docker network, with a stable internal hostname (for example `<db-name>.fleet.internal`).
- Cross-node: TCP stream forwarding through the existing tunnel. Verify what the tunnel supports and extend it with backward compatibility if needed. Document the latency cost.
- `fleet db link <db> <service>` injects secrets via the existing secrets system:
  - `DATABASE_URL` (pooled via PgBouncer, with `?pgbouncer=true` for Prisma) and `DIRECT_URL` (direct, for migrations; matches Prisma's `directUrl`), plus `REDIS_URL` for Redis.
  - Custom env var names via `--as`. Multiple databases of one engine on one service get prefixed names (for example `ANALYTICS_DATABASE_URL`).
  - Roles: `app` (default, limited privileges) and `readonly`.
- Linking marks the service "restart required" and offers to redeploy. Unlinking removes the secrets and does the same.
- Ship short docs snippets for Prisma, Drizzle, node-postgres, SQLAlchemy, and Django, including the pooled vs direct URL rule.

### 6.6 Postgres specifics
- Versions: 16 and 17 at minimum (more if images and extensions are available).
- Roles: `owner` (migrations and admin), `app`, `readonly`. Strong random passwords, `scram-sha-256`.
- Curated extensions in the image: pgvector, pg_stat_statements, pgcrypto, uuid-ossp, pg_trgm. `fleet db extension list|enable|disable`.
- **Auto-tuning from allocated memory and node characteristics**: `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `max_connections` (tied to PgBouncer pool sizing), WAL and checkpoint settings, `random_page_cost` for SSD vs slow disk, autovacuum settings. Profiles: `dev`, `standard`, `performance`. Show the effective config, allow overrides only for an allowlist of safe parameters, and warn when the node has a Pi/SD-card storage profile.
- **PgBouncer sidecar** in transaction mode by default, with correct sizing, and a direct endpoint for migrations and admin tools.

### 6.7 Redis specifics
- Modes: `cache` (no persistence, `maxmemory` set, `allkeys-lru`) and `durable` (AOF, `noeviction`, with explicit warnings that out-of-memory means write errors, not silent loss).
- `requirepass` plus ACL users, memory limit derived from allocation, and RDB snapshots to the backup target on a schedule for durable mode.

### 6.8 Backups, restore, recover, import, export
- **Postgres**: continuous WAL archiving plus scheduled base backups using WAL-G (or an equivalent you justify) to the backup target, **client-side encrypted**. Stream backups; never require a full temp copy on the DB's disk. Default: daily base backup, continuous WAL. Retention policy with sensible defaults (for example 7 daily and 4 weekly).
- **Redis**: RDB snapshot uploads on a schedule.
- **Manual backup** with a label, and an automatic **pre-migration restore point** (record a named restore point and LSN/time so it can be a restore target).
- **Restore modes**:
  - To latest, to an exact timestamp (point-in-time), to a named point (`pre-migration`), or from a specific backup.
  - **Into a new database** (safe default and recommended).
  - **In place**: stop the DB, keep the old volume aside as a safety copy (kept until confirmed or a TTL), check free disk first, and show exactly what will be lost.
- **`fleet db recover`**: after node loss, rebuild the database on another eligible node from the backup target, with a clear display of the data-loss window (time between last archived WAL and now), then re-point links and restart linked services.
- **Dump/export**: `fleet db dump` produces a standard portable dump (`pg_dump` custom format; Redis RDB) for download. Export must always work with no lock-in.
- **Import**: `fleet db import --from <postgres url | dump file | redis url>` into a new or empty database, with pre-checks (version compatibility, size estimate, connectivity from the node) and progress.
- Backup health is a first-class status: last successful backup, WAL archive lag, and failures all surface in status and alerts.
- Without a configured backup target, creation still works but shows a loud, persistent warning that there are no off-node backups, and it offers `fleet backup-target add`.

### 6.9 Migrations as a release phase, and declarative config
- During a deploy, **before traffic switches**, detect and run migrations:
  - Prisma (`prisma migrate deploy`), Drizzle (`drizzle-kit migrate`), or a custom command from the project config.
  - Run as a one-off container (same image as the new build) on the database's network using the **direct** `owner` URL.
  - Take a pre-migration restore point first. Use an advisory lock so concurrent deploys never double-migrate. Apply a configurable timeout. Stream logs.
  - **On failure: abort the deploy, keep the old version serving, record the run, show logs, and offer the exact restore command.**
- Migration run history per database and per deploy (tool, command, duration, status, logs, restore point).
- `fleet db migrate <db>` (manual, supports `--dry-run` where the tool allows), `fleet db exec` (SQL/file), `fleet db shell` (psql/redis-cli executed **inside the container through the agent**, so no local client is needed, which matters for Windows users), and seed/one-off script runs.
- **Declarative config**: a `databases:` block in the project config (engine, version, name, link target). A deploy **creates the database if missing and links it**. Config is never allowed to delete, shrink, or downgrade anything; destructive changes always go through explicit CLI confirmation.

### 6.10 Monitoring, alerts, tuning visibility
- The agent collects on an interval, with low overhead:
  - Postgres: connections (active/idle/max), TPS, cache hit ratio, DB size, top table sizes, slow queries via `pg_stat_statements`, locks and blocked queries, WAL archiver status/lag.
  - Redis: memory, hit rate, ops/sec, evictions, clients, persistence status, slowlog.
  - Both: container CPU and memory, volume disk usage and growth.
- Storage: recent window in Redis, rollups in Postgres, with retention rules. Paginate and downsample for charts.
- **Alerts** (in-app, CLI, and generic webhook with Slack/Discord-compatible formatting; reuse the existing notification mechanism if one exists): node offline, disk above 80% and 90%, backup failed or stale, WAL archive failing, connections near max, memory high, DB unreachable. Alert rules have sane defaults and per-database overrides, with deduplication and recovery notices.

### 6.11 Security
- No public exposure. Internal network only, plus authenticated tunnel access.
- Credentials encrypted with the existing secrets system, redacted everywhere in logs and errors, never passed in process args.
- `db connect` uses short-lived scoped tokens, is revocable, and every session is recorded.
- Encrypted backups; backup-target credentials encrypted.
- Typed confirmation for delete, in-place restore, and recover.
- Permission checks on every route consistent with the existing auth model.

### 6.12 Agent changes (Go)
Volume lifecycle (create, remove, inspect, usage), stateful container management, exec and interactive PTY streaming (for `db shell`), TCP stream proxying over the tunnel, backup/restore runners, metrics collection, disk and arch/storage-type reporting, node stability reporting, capability advertisement, image pre-pull, graceful shutdown that cleanly stops databases (a clean Postgres stop, never a kill). Bump the agent version, keep old agents working, and make the control plane show "agent upgrade required" for DB features.

### 6.13 API
Follow the existing conventions (and OpenAPI/schema validation if present). At minimum: databases (CRUD, start/stop/restart, status, info), credentials (reveal with authorization, rotate), links, backup targets (CRUD, test), backups (list, create, download, delete), restores, recover, import/export, migrations (runs, trigger), extensions, tuning, metrics (query by range), slow queries, alerts (rules, events), operations (list, get, SSE stream), logs (SSE), and connect-token issuance. Everything long-running returns an operation ID.

### 6.14 CLI (`fleet db ...`)
```
fleet db create <engine> [--name] [--version] [--node] [--project] [--size|--memory --cpu --disk]
                         [--mode cache|durable] [--backup-target] [--link <service>] [--yes] [--json]
fleet db list | status <db> | info <db> | logs <db> [-f] | metrics <db> [--watch] | slow <db>
fleet db url <db> [--direct] [--reveal]
fleet db link <db> <service> [--as NAME] [--role app|readonly]  |  fleet db unlink <db> <service>
fleet db connect <db> [--port] [--role]     (local tunnel; works with psql, TablePlus, Prisma Studio)
fleet db shell <db>  |  fleet db exec <db> -c "SQL" | -f file.sql
fleet db migrate <db> [--dry-run] [--command]
fleet db backup <db> [--label]  |  fleet db backups <db>
fleet db backup download <db> <backup-id> <file>
fleet db restore <db> [--backup id | --to <timestamp|latest|pre-migration>] [--into-new <name> | --in-place]
fleet db recover <db> [--node]
fleet db dump <db> [-o file]  |  fleet db import <db|new> --from <url|file>
fleet db extension list|enable|disable <db> <ext>
fleet db tune <db> [--profile] [--set key=value]
fleet db credentials <db> [--role] [--rotate]
fleet db start|stop|restart|delete <db>
fleet db alerts <db>
fleet backup-target add|list|test|remove|default
```
Requirements: interactive prompts when flags are missing, fully non-interactive with flags, `--json` everywhere, meaningful exit codes, progress for long operations, and plain-language errors that always include the next step. Use the **existing shared output helpers and current visual style** (check whether the recent CLI output redesign has landed, and reuse it). Do not create a second style.

### 6.15 Frontend (real pages, real data, great UX)
Match the existing design system and tokens. Quality bar: clear states, honest status, safe destructive actions, zero dead buttons, realtime via SSE (not polling), responsive, keyboard accessible, with loading skeletons, empty states with a clear next action, and error states with recovery steps.

Pages and flows:
1. **Databases list** (project-scoped and global): engine icon, status, node, size, last backup and data-loss window, linked services, health. Filters and search.
2. **Create database wizard**: engine → version → name → placement (recommendation plus reasoning plus stability warnings) → resources and tuning profile → backup target (add inline if none, with a connectivity test) → link services → review → live provisioning progress.
3. **Database detail** with tabs:
   - *Overview*: health, key metrics, connection strings (pooled/direct, masked with reveal and copy), linked services, backup health banner, "what happens if this node dies" panel.
   - *Metrics*: real charts over selectable ranges.
   - *Backups & Restore*: timeline of backups, point-in-time picker, restore wizard (new DB vs in place, with a clear impact summary), download dumps, recover flow.
   - *Migrations*: run history linked to deploys with logs and restore points.
   - *Links*: manage links, env names, roles, pending-restart state.
   - *Schema* (read-only table/column/size browser).
   - *Logs*: live stream.
   - *Settings*: resources, tuning, extensions, credentials/rotation, alerts, danger zone with typed confirmation.
   - *Activity*: all operations with status and logs.
4. **Backup targets** settings page (add, test, default, remove).
5. **Integration with existing pages**: databases appear in the project topology; service pages show linked databases and injected env var names (never values); the deploy page shows the migration phase as a step with logs and failure handling; node pages show hosted databases, disk usage, and stability score.

### 6.16 Docs
`docs/db/`: concepts, quickstart, CLI reference, backup and restore runbook (including recover), migrations guide (Prisma/Drizzle/custom), connection guides, tuning notes, troubleshooting, security notes, and `DOGFOOD-RAUNAK.md`: an exact step-by-step runbook (with rollback) for moving the Raunak project's PostgreSQL onto Fleet Databases. **Write the runbook only. Do not execute it.**

---

## 7. V2 SPECIFICATION (build after v1 is complete and verified)

1. **Replication and read replicas**: streaming replication to a second node using replication slots (bootstrap via base backup), `fleet db replica add|remove|list`, replication lag metrics and alerts, a read-only connection string for read replicas. Redis replicas (`replicaof`) with manual promote. Redis Cluster is out of scope.
2. **Manual promote with fencing**: `fleet db promote`. The old primary must be fenced (stopped or demoted), and rejoin safely when it returns (use `pg_rewind` where applicable). Re-point links and roll linked services.
3. **Automatic failover (opt-in only)**: conservative by design. Require replica lag under a threshold, fencing, a grace period, flap protection, and split-brain prevention. State clearly the limits of the control plane acting as witness. Show the potential data-loss window before enabling. Back it with **chaos tests**: kill the agent, drop the tunnel, partition the control plane, restart mid-promotion.
4. **Database branching**: `fleet db branch create|list|delete` from a backup, a point in time, or the current state (restore-based; document the time cost versus size). TTL auto-cleanup. Preview-environment integration if the product has previews: a branch per preview deploy, deleted with it.
5. **Masked clones**: clone to staging or local with column-level anonymization rules (emails, names, phone numbers, free-text), defined declaratively and reviewed before running.
6. **Scheduled restore drills**: automatically restore the latest backup into a throwaway container, run integrity checks, report success or failure. A backup nobody has restored is not a backup.
7. **Web SQL console and table browser**: read-only by default, explicit write mode, statement timeouts, query history, saved queries, `EXPLAIN` view, row limits, every query recorded in the audit log.
8. **Insights**: slow-query analysis, rule-based index suggestions, unused/bloated index detection, vacuum/bloat health, and **disk growth forecasting** ("disk full in about 12 days").
9. **Planned move between nodes** (`fleet db move`): replica-based low-downtime cutover when a replica exists, otherwise backup/restore with a brief outage. Orchestrate link re-injection and rolling restart of linked services.
10. **Resize**: CPU and memory changes with automatic retune, and storage relocation or expansion workflows.
11. **Major version upgrades**: dump/restore or `pg_upgrade` in a one-off container, rehearsed first on a branch, with a rollback path.
12. **Zero-downtime credential rotation**: dual-role rotation, re-inject, rolling restart of linked services.
13. **Temporary access grants**: `fleet db access grant --ttl 1h --role readonly`, auto-expiring and fully audited.
14. **Audit log and RBAC**: every database operation and access recorded and exportable; roles consistent with the existing auth model (who can see credentials, restore, delete, or use the console).
15. **Optional public access**: TLS plus an IP allowlist, off by default. Evaluate the TCP/SNI routing options and document the tradeoffs before choosing.
16. **Backup targets and retention**: more target types (SFTP, another node, one-click Fleet-hosted MinIO), multiple targets for 3-2-1 backups, retention policy editor, and capacity warnings.
17. **Notifications**: Slack, Discord, Telegram, and email channels for alerts, with per-database routing.
18. **More engines** via the plugin interface: MySQL/MariaDB, MongoDB, SQLite via Litestream (a sidecar model suited to Pi nodes), the PostGIS extension, and an evaluation of Valkey as a Redis alternative.
19. **Maintenance windows** for upgrades, restarts, and heavy operations.
20. **Frontend for all of the above**, at the same quality bar as v1.

---

## 8. Engineering standards

- **Testing (real, not decorative)**: unit tests; integration tests against **real Docker** containers for engines, backups, and restores; end-to-end tests driving the CLI against a local control plane plus a local agent; frontend component tests and **Playwright flows** for create, link, backup, restore, and delete; chaos tests for v2 failover.
- **Types, lint, build** all clean. Control-plane schema changes go through the Drizzle migration flow (generate, never hand-edit). Every migration must be safe to run against a populated database.
- **Idempotency and resumability**: retrying any operation is safe, and a control-plane restart mid-operation resumes or fails cleanly with a visible state.
- **Performance**: `db create` should be ready in well under a minute on a node with the image pre-pulled. Backups are streamed. Metrics collection is lightweight. The UI paginates and streams (SSE), and never polls aggressively.
- **Observability**: structured logs, operation logs persisted, secrets redacted everywhere.
- **Error design**: every error says what happened, why, and the exact next command or click.
- **Multi-arch**: images and agent builds verified on arm64 and amd64, and Windows Docker Desktop behavior verified or explicitly documented.

---

## 9. Milestones

**V1** (commit and note after each; build the API first, then its UI right after, and never leave the UI to the end):
1. Foundations: schema, engine plugin interface, operation framework, capability negotiation.
2. Agent stateful runtime: volumes, lifecycle, exec/PTY, TCP stream proxy, disk reporting, multi-arch images in the private registry.
3. Postgres create/lifecycle, scheduler stateful class, placement, affinity, networking, links, env injection, PgBouncer.
4. Redis engine.
5. Backups: targets, WAL archiving, base backups, schedules, retention, all restore modes, recover, dump, import.
6. Migrations release phase, declarative `databases:` config, `exec`, `shell`, `migrate`.
7. Monitoring, alerts, tuning visibility.
8. CLI completeness and polish.
9. Frontend completeness and polish.
10. Hardening: security pass, full e2e suite, docs, release prep. Open the v1 PR.

**V2**: replication and promote → automatic failover with chaos tests → branching and masked clones → SQL console and insights → move, resize, upgrade, rotation → access grants, audit, RBAC, public access, notifications, restore drills, more targets → more engines → hardening and docs. Open the v2 PR.

---

## 10. Acceptance scenarios (all must pass for real before you call a version done)

**V1**
1. Fresh project: `fleet db create postgres` → `fleet db link` → `git push`. The migration runs, the app serves traffic, backups start. Kill and recreate the app container: data persists.
2. Point-in-time: insert rows, note time T, delete the rows, restore to T into a new database, and the rows are back.
3. A failing migration aborts the deploy, the old version keeps serving, a pre-migration restore point exists, and the logs and restore command are shown.
4. Node offline: the DB shows `unreachable`, an alert fires, linked services are **not** rescheduled onto an empty DB, and `fleet db recover` restores onto another node from the backup target, showing the data-loss window.
5. `fleet db connect` works with `psql` and Prisma Studio over localhost; a revoked token stops working immediately.
6. Redis: cache mode evicts under pressure; durable mode survives a restart with data intact.
7. Import an external Postgres into a Fleet database, then export a dump and restore it elsewhere.
8. Delete flow: typed confirmation, final backup, recovery within the grace period.
9. An old agent (v0.2.x) keeps running services, and DB actions show "agent upgrade required."
10. Secrets never appear in any log, error, API response (unless revealed by an authorized request), or process list.
11. Playwright runs the full UI flows: create wizard, backup, restore (both modes), link, delete.

**V2**
1. Add a replica, verify it is in sync, and run `promote` with fencing; the old primary rejoins safely.
2. Chaos: kill the primary's agent and drop the tunnel; automatic failover (when enabled) promotes only within its safety rules and never causes split-brain.
3. Branch a database, run a destructive migration on the branch, and the source is untouched. Masked clone shows anonymized columns.
4. Restore drill runs on schedule and reports pass or fail.
5. Planned move between nodes completes with the documented downtime and linked services re-pointed.
6. Major-version upgrade rehearsed on a branch, then applied, with rollback verified.
7. Credential rotation with no failed requests on a running app.
8. Temporary access grant expires on time and appears in the audit log.

---

## 11. Final report (when each version is done)

Provide: what was built (by milestone), what was verified and how (test names and results), differences between this prompt and the real codebase, decisions made, anything incomplete or deliberately deferred (stated plainly), known risks, upgrade/migration steps for existing installs, and the exact commands to try the feature end to end. Do not claim anything works unless you ran it.
