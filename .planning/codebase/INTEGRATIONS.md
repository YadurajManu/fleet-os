---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS integrations

**Analysis Date:** 2026-09-29

- PostgreSQL is the durable store for fleets, nodes, services, deployments, build jobs, secrets and audit records (`control-plane/src/db/schema.ts`).
- Redis stores ephemeral heartbeat snapshots, event progress and logs (`control-plane/src/api/`).
- GitHub App installation and webhook flows live in `control-plane/src/github/` and `control-plane/src/api/github.routes.ts`.
- Authentication and sessions are handled in `control-plane/src/api/auth.routes.ts` and related `control-plane/src/auth/` modules.
- The CLI authenticates via `cli/src/commands/auth.ts`, persists a profile in `cli/src/config.ts`, and sends requests via `cli/src/api.ts`.
- Agents connect outbound over WSS (`agent/internal/client/client.go`; `control-plane/src/api/agent.routes.ts`).
- Agents report Docker Engine platform/capacity and reconcile Docker workloads (`agent/internal/`).
- Build jobs use agent-side BuildKit or server-side Buildx (`control-plane/src/build/`).
- The private registry is fronted by the scoped gateway (`control-plane/src/build/transfers.ts`; `deploy/caddy/Caddyfile`).
- Caddy serves TLS and forwards application ingress through the control-plane tunnel (`deploy/caddy/Caddyfile`).
- The marketing site publishes static assets through Nginx (`www/nginx.conf`).
- Email dispatch and alert templates are in `control-plane/src/alerting/`.
- External source download grants are short-lived; see `control-plane/src/build/credentials.ts`.
- Webhook routes are registered in `control-plane/src/api/webhooks.routes.ts`.
- The CLI can upload a local tar context directly through `POST /services/:id/build-context`.
- API schema and migration compatibility matter because older agents remain connected during upgrades.
- Deployment configuration and operator instructions are under `deploy/` and `deploy/aws/README.md`.
- No integration secret values belong in this map; refer to `.env.example` files for variable names.
- The direct TLS registry host is distinct from the dashboard/API hosts (`docs/ARCHITECTURE.md`).
- `fleet.yaml` is the user-facing application manifest (`docs/fleet-yaml-spec.md`).
- Source provenance differs between GitHub checkouts and local uploaded contexts.
