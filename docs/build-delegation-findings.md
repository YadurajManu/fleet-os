# Agent-delegated builds: repository findings

Inspected at main dce4804, before implementation. Fleet calls applications `services`; the new fields belong to that table, not a parallel apps table.

## Existing build paths

`control-plane/src/api/deploy.ts` handles webhook deployment and calls `ctx.builds.build`. The manual/CLI path independently calls the same interface in `api/services.routes.ts`. Both must pass deployment/service identity to the new runner. `build/runner.ts` defines BuildRunner; `api/context.ts` currently constructs BuildxRunner. `build/context.ts` validates and extracts uploaded tar contexts. GitHub webhook code checks out source before calling deployFromPush.

`build/buildx.ts` runs Buildx, groups platforms by configured builder, and merges multi-platform outputs with `docker buildx imagetools create`. That command manipulates registry manifests and does not execute Dockerfiles. Keep the existing implementation for BUILD_MODE=local and reuse registry manifest assembly for the new path. Existing deploys use the first returned tag; delegated results must return a digest-qualified reference.

## Placement and persistence

`db/schema.ts` stores nodes, services, deployments, and placement events. `scheduler/snapshot.ts` combines database capacity with Redis heartbeat load; `placement.ts` filters architecture, state, memory, GPU, placement, volume locality, affinity, and reliability. Capacity currently comes from host totals. The current default build target is the selected node's architecture, not all eligible failover nodes.

New engine-capacity fields must be optional for v0.2.4. Older nodes must remain workload candidates under their existing architecture contract and must never become builders without an explicit capability report. New agents must derive the Linux container platform and effective capacity from Docker info rather than host GOARCH.

## Tunnel and logs

`agent/internal/tunnel/client.go` opens an authenticated outbound WebSocket, reconnects after 3 seconds, and serializes writes. `tunnel/registry.ts` tracks authenticated node sockets, ping/pong liveness, HTTP request IDs and terminal session IDs. There is no build acknowledgement or durable build protocol today. Build messages require version, job ID and attempt; responses must be bound to the authenticated node, not a payload-supplied identity.

`api/log-stream.ts` publishes Redis log entries and serves SSE; deploy progress is recorded by `api/deploy-progress.ts`. Build logs need service/deployment identity and replay storage, cancellation and terminal failures need durable job state. Runtime logs currently use service-name channels, so any build integration must preserve fleet isolation rather than assuming service names are globally unique.

## Registry, source, lifecycle

The private distribution registry currently uses htpasswd credentials (`REGISTRY_CREDENTIALS`); Buildx logs in with those credentials. It has no job-scoped token issuer. Sending those credentials to opted-in agents would grant registry-wide access; scoped token authentication or an explicitly documented exception is required before claiming ephemeral credentials.

Agent registration sends capability.Report; heartbeats carry runtime/deployment information and agent version. Agent self-update is opt-in, checksum-based, and installs on supervisor restart. Linux has an installer-generated systemd pre-start step; macOS has launchd. There is no Windows service installer in scripts, and Windows binary replacement needs a separate stopped-process path.

## Validation and rollout boundaries

Use disposable local Postgres/Redis on ports 15432/16379, not the deployed database. Before each phase commit run all existing TypeScript typechecks and tests, dashboard/site builds, go vet, go test and git diff --check. No JS lint script is configured; go vet is the existing Go static-analysis check. CI also cross-compiles the agent targets.

This run ends at a green feature PR. No merge, deployed config change, production migration, live agent replacement, release tag or package publication is authorized.
