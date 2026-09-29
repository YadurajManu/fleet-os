---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS architecture map

**Analysis Date:** 2026-09-29

- `docs/ARCHITECTURE.md` is the authoritative architectural overview.
- The control plane owns desired state, auth, scheduling, builds, and ingress (`control-plane/src/`).
- The CLI and dashboard are control-plane API clients (`cli/src/api.ts`; `dashboard/src/`).
- The agent owns Docker interaction and sends heartbeats/reconciliation data over outbound WSS (`agent/internal/`).
- PostgreSQL is durable state; Redis is transient telemetry/log distribution (`control-plane/src/db/`; `control-plane/src/api/`).
- Build orchestration is behind a runner selected by `BUILD_MODE` (`control-plane/src/build/`).
- Local source: CLI archive (`cli/src/archive.ts`) → upload route (`control-plane/src/api/services.routes.ts`) → extraction (`control-plane/src/build/context.ts`) → build job.
- GitHub source: App webhook/API → exact repository checkout (`control-plane/src/git/checkout.ts`) → build job.
- Deploy API opens a deployment, builds by digest, selects a node, and waits for runtime health (`control-plane/src/api/deploy.ts`).
- Placement accounts for platform, health, capacity, persistence and pinning (`control-plane/src/scheduler/`).
- Agent reconciliation starts containers and reports evidence; the old healthy release remains routed during stateless replacement.
- Caddy accepts public traffic and forwards via the control-plane ingress proxy to agent tunnels (`deploy/caddy/Caddyfile`).
- The registry gateway scopes builder push permissions to job attempts (`control-plane/src/build/transfers.ts`).
- User-facing deployment metadata is read from the deployments table (`control-plane/src/db/schema.ts`).
- Local snapshot identity should be based on actual archive entries, not Git status or compressed tar bytes.
- The last successful running release is the appropriate diff baseline; failed attempts are not.
- `cli/src/commands/services.ts` handles one-service deployment; `cli/src/commands/up.ts` handles manifest deployment.
- `control-plane/src/api/services.routes.ts` handles authenticated service and deployment routes.
- `dashboard/src/` renders operational state; it is not a separate scheduler or source of truth.
- `www/src/` is independent public marketing content.
