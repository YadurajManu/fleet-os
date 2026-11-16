# Fleet Databases: system understanding

Reviewed against commit `4c041c1` on `feat/db-v1`, 2026-11-16. This records observed code, not a claim that the requested database product exists.

## Components and deploy path

| Component | Current implementation and evidence |
| --- | --- |
| CLI | Independent TypeScript npm package, `cli/package.json`, version 0.27.1. Custom argument parser (`cli/src/args.ts`), command registry (`commands/index.ts`), entrypoint (`index.ts`); no Commander dependency. |
| API | Fastify, Zod, postgres-js, Drizzle, ioredis (`control-plane/package.json`, `src/server.ts`, `src/api/context.ts`). Context owns the database pool, Redis, heartbeat tracker, build runner, tunnel registry and in-flight deploy promises. |
| Scheduler | Pure filter/rank functions in `control-plane/src/scheduler/placement.ts`; persisted state translated in `snapshot.ts`; failover in `reschedule.ts`, replicas/reclaim/tasks in adjacent modules. |
| Agent | Go 1.24 module (`agent/go.mod`). `cmd/agent/main.go` starts capability discovery, sampling, heartbeat, reconcile, tunnel, upgrade and volume-backup loops. Docker Engine API client in `internal/docker/`. |
| Tunnel | `control-plane/src/tunnel/registry.ts`, `terminal.ts`, `agent/internal/tunnel/client.go`. Outbound agent WebSocket, bearer authentication, multiplexed JSON messages and base64 payloads. |
| Builds/registry | `control-plane/src/build/{runner,agent,buildx,platforms,manifests}.ts`; delegated builds selected by `BUILD_MODE=agent`. Registry credentials and image platform metadata flow into desired state. |
| Ingress | `control-plane/src/ingress/{proxy,routes,domains}.ts`, Caddy configuration under `deploy/caddy/`. HTTP routes can use reverse tunnels or advertised node addresses. |
| Dashboard | Existing React 19 / React Router 7 / Vite / Tailwind 4 package (`dashboard/package.json`), independent from the marketing site `www/`. Reuse it. |
| Shared behavior | No root workspace package. Contracts are duplicated across TS and Go. Shared CLI rendering is local to `cli/src/{render,presentation,ui}.ts`. |

Repository deployment starts at webhook/import routes, passes through `api/repo-deploy.ts:deployRepository`, obtains a tenant-authorized GitHub installation token, checks out the commit, reads `fleet.yaml`, parses it and syncs it. `deployFromPush` is shared with repository-triggered deploys. Local CLI uploads and manual deployment also have paths in `api/services.routes.ts`; every traffic-switch path must receive the migration gate.

`api/deploy.ts:deployFromPush` validates secrets, inspects image platforms, takes a scheduler snapshot, opens a durable deployment row, builds when necessary, rechecks placement after delegated builds, allocates a host port and transitions to `deploying`. It currently supersedes prior active deployments in this transaction. Agent desired state is produced in `api/agent.routes.ts`; `agent/internal/reconcile/reconcile.go` creates/reconciles containers and reports progress/health. Agent heartbeat handling advances rollout state and invalidates ingress routes. New migrations must run before old deployment supersession, not after it.

## Placement, headroom and failures

`scheduler/placement.ts` weights headroom 0.5, reliability 0.3, load 0.2, with deterministic node-ID tie breaks. Filters reject offline/cordoned/draining nodes, incompatible platforms, inadequate RAM/CPU, absent GPU/tags, reliability mismatches and affinity conflicts. Existing `affinity` is a hard co-location constraint when its target is placed; the requested database affinity is soft and must have distinct semantics.

`scheduler/snapshot.ts` reserves RAM/CPU from active deployments, assigned/running builds and unexpired one-off task reservations. It uses Docker effective capacity when available. It does not yet reserve tenant database disk/RAM or include free disk in `NodeSnapshot`. `nodes.diskMb` and heartbeat disk fields exist; host disk and Docker-volume disk must not be conflated on Desktop.

`reschedule.ts` holds pinned services with `pinned_unavailable`; flexible/preferred workloads are reconsidered after node loss. The volume-node check prevents a volume automatically following a deployment. There is no separate stateful database class. `heartbeat/tracker.ts` uses TTL keys plus sorted sets; sweeping is pull-based and has control-plane restart grace. Existing reliability score is not the requested measured uptime/flap history.

## Networking and agent runtime

The tunnel supports `http_request/response`, terminal start/data/resize/close/ping, delegated builds and `task_start/task_cancel/task_result`. IDs multiplex independent work. `TunnelRegistry` tracks pending requests per node and rejects them on disconnect; both sides use WebSocket keepalives, and the Go client reconnects after three seconds. Task concurrency is limited per node. It has no raw TCP open/data/window/half-close protocol; HTTP request buffering cannot carry a Postgres session correctly.

`agent/internal/docker/network.go` creates one user-defined bridge named `fleet` per node. `lifecycle.go` gives containers service-name DNS aliases. Same-named services in different projects therefore need scoped networks for the new product. There is no transparent cross-node Docker DNS/network. `manifest/parse.ts` currently pins database consumers to the database node and rejects mismatched explicit placement. New cross-node connectivity must be built, not inferred from HTTP ingress.

`docker/lifecycle.go:RunSpec` includes image/platform, environment, named volume/mount path, ports, memory and health configuration. Containers use `unless-stopped`. Public port bindings use `0.0.0.0`; internal services omit bindings. New databases must omit host bindings entirely, including PgBouncer. Existing health configuration generates HTTP checks; database readiness needs engine-specific checks. Desired-state reconciliation keys on labels/deployment IDs. Stable volume identity must survive a changed database operation/container ID.

`capability/engine.go` describes the Linux container engine, supporting Desktop on macOS/Windows, rather than assuming the host's architecture/capacity. It reports task/build capabilities. `capability.Report` includes agent version, registration and heartbeats carry optional fields. `main.Version` is stamped with linker flags; upgrades stage and validate binaries (`internal/upgrade/`), with fleet/node policy gates. Database capability flags must default to unsupported for old agents, and must not be inferred from a version number.

## Secrets, identity and tenancy

`lib/crypto.ts` seals secrets with independent random DEKs using AES-256-GCM and wraps each DEK with `SECRETS_MASTER_KEY` (32-byte base64). The database stores an authenticated envelope, not plaintext. `secrets/store.ts` stores fleet/service-scoped keys; values resolve for agent desired state. Existing manifest passwords are generated once in `manifest/sync.ts`; regenerating on apply would lock users out. New database credentials will use the same encryption primitive with project/resource ownership and explicit reveal auditing.

`api/guards.ts` verifies access JWTs or HttpOnly cookie sessions, checks revocation, and resolves organization membership through a fleet. Agent tokens are hashed, with separate guards/cache invalidation. `auth/rbac.ts` uses viewer/deployer/admin/owner roles and explicit permissions. Database endpoints must scope resource lookup to fleet AND project before returning anything, including operation streams and credential reveals. GitHub clone authorization is organization-scoped in `github/installations.ts`.

Projects are strings on services (`db/schema.ts`), not a separate project table. Service identity is `(fleet, project, name)`. The new resource must honor that model rather than invent project IDs or cross-tenant global lookup by name.

## Manifest and existing databases/backups

`manifest/parse.ts` parses YAML with Zod, handles image/build, resources, placement, health, secrets and a top-level `databases` record. `manifest/databases.ts` currently provides Postgres, Redis, MySQL, MariaDB and Mongo image/default/environment templates. Databases expand into pinned internal SERVICES with named volumes. Redis has no password in this legacy path. URLs use secret references, and consumer environment/placement is derived. This is not the independent workload/resource described by the request.

`manifest/sync.ts` generates missing credentials, upserts services by project/name, preserves stored pins and reports orphaned services without deletion. Preserve existing manifests. New declarative resources require an explicit format transition/migration policy; silently reinterpreting a running legacy database as a new one is unsafe.

`backup/store.ts`, `backup/schedule.ts`, `api/backups.routes.ts`, `agent/internal/backup/backup.go` implement volume archives, control-plane storage, schedules and restore jobs. The agent buffers archives in memory before upload. A live volume tar is not a Postgres base backup and provides no WAL/PITR guarantee; never relabel it as one. Existing restore requires stopped services. Keep these commands for existing volume users and implement streamed engine backups for new databases separately.

## CLI and dashboard conventions

`cli/src/index.ts` owns grouped help; `commands/index.ts` registers commands. `args.ts` validates known flags. API requests and exit codes use `api.ts:CliError/EXIT`. Render helpers in `render.ts` and operation presentation in `presentation.ts` are the existing style; `ui.ts` sends animation to stderr so JSON stdout stays parseable. Prompts must respect noninteractive usage. New flag names must enter the shared parser, not just a command handler.

Dashboard routes live in `dashboard/src/main.tsx`, navigation in `components/Shell.tsx`, reusable UI in `components/ui.tsx`, auth/fleet selection in `lib/auth.tsx`, requests/types in `lib/api.ts`. CSS tokens in `index.css` use Archivo/JetBrains Mono, dark ink backgrounds, green signal, amber warning and red down. Existing service/node pages rely substantially on `usePoll` (default 4 seconds). The requested database pages must add authenticated SSE and durable cursor replay rather than copying that polling pattern. Logs already stream through authorized Redis-backed SSE (`api/log-stream.ts`, `service-logs.ts`), which provides a pattern for access/session checks and cleanup. Existing terminal UI uses xterm.

## Tests, migrations and release

Node's built-in test runner plus tsx serves API/CLI tests. Control-plane tests need real Postgres/Redis and often use Fastify injection with disposable users/fleets. Dashboard tests use happy-dom plus React; no Playwright dependency is currently listed. Go uses `testing`, fake Engine HTTP servers for units and explicit Docker integration tests. `.github/workflows/ci.yml` checks these packages independently, provides Postgres 16 and Redis 7 for API tests, and validates Caddy/installer scripts.

`control-plane/drizzle.config.ts` points at `src/db/schema.ts`; `npm run db:generate` generates migrations and `src/db/migrate.ts` applies them. Startup migrates before listen. SQL history currently reaches 0041, while checked-in Drizzle snapshots reach only 0002: generation against this old baseline will try to recreate already-added objects. Reconcile snapshot metadata against a disposable database migrated through all existing files before generating additions. Never alter already-applied SQL.

There is no repository-root package.json. Use package-specific npm scripts. CLI is currently 0.27.1, control plane 0.2.0, dashboard 0.1.0; agent release version is stamped. Prepare changelogs/version changes after compatibility tests, do not publish npm or change deployed agents. V1 and V2 need separate unmerged PRs, V2 based on verified V1.

## Differences, risks, unknowns and change surface

Differences from the supplied architecture: a dashboard already exists; database declarations already exist as services; a fleet-wide bridge is not a private project network; cross-node raw TCP does not exist; existing tar backups buffer and are not PITR; affinity is currently hard; a distinct project table and stateful resource class do not exist. Delegated builds are already present in source, regardless of the prompt's PR number.

Unknown until verified: private registry write credentials and available maintained engine images; S3-compatible backup destination; actual production node storage profiles; arm64/amd64 real-hardware coverage; Windows Desktop behavior; multi-node network latency/fencing availability. No production or Raunak access is needed for discovery or local tests. Raunak migration is documentation only.

Expected changes: new `control-plane/src/databases/` engine/operation/runtime modules; `db/schema.ts` and generated migrations; `api/database*.ts`, guards/RBAC/server registration; agent capability/client/tunnel plus a dedicated database runtime; scheduler snapshot/placement and node sweep integration; secrets resolution; shared deploy gate across manual/local/webhook paths; manifest parser/sync; CLI args/help/registry plus database/target commands; dashboard routes/navigation/types/SSE and database/target pages; images under `deploy/databases/`; CI and unit/integration/E2E/chaos tests; `docs/db/` runbooks and release notes. Existing services, fixtures and output tests must stay compatible.
