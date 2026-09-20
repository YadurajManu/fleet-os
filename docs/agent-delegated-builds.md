# Agent-delegated builds

`BUILD_MODE=agent` is the default. The control plane creates durable build jobs and sends them through existing outbound WSS tunnels. An opted-in agent runs a dedicated BuildKit container. The local Buildx runner remains available with `BUILD_MODE=local`; switching modes requires restarting the control plane.

This change does not deploy, publish, or automatically enable any existing agent.

## Prerequisites and configuration

Agents need Docker with a Linux engine, the Buildx plugin, and Git for GitHub sources. Windows means Docker Desktop with WSL2 and Linux containers; native Windows containers are rejected with `Switch Docker Desktop to Linux containers`. macOS also uses the Docker Desktop Linux VM. Capabilities come from `docker info`, including the VM's CPU and memory, rather than host totals.

The control plane still needs the Docker CLI and Buildx plugin for **registry-only** `imagetools inspect/create`. These commands do not run Dockerfiles or require a Docker daemon. Its existing Docker access is retained solely for the explicit local fallback.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUILD_MODE` | `agent` | `agent` or the existing `local` runner |
| `ALLOW_QEMU_FALLBACK` | `false` | Permit an amd64 builder to build another Linux platform when no native builder is eligible; binfmt/QEMU must already be configured |
| `BUILD_REGISTRY_URL` | `PUBLIC_API_URL` outside Compose | HTTPS origin for the scoped `/v2/` upload gateway |
| `PUBLIC_API_URL` | existing configuration | HTTPS origin for source downloads and the API |
| `REGISTRY_URL` | required for builds | Existing upstream registry, also used for immutable pull references |
| `REGISTRY_CREDENTIALS` | existing configuration | Upstream registry authentication; never sent to builders as push credentials |
| `BUILD_TIMEOUT_MS` | existing configuration | Per-attempt timeout, capped at one hour for delegated jobs |

Compose supplies `BUILD_REGISTRY_URL=https://fleetbuilds.${INGRESS_ZONE}`. Before a later deployment, add a **DNS-only** A/AAAA record for that hostname to the control-plane server and permit Caddy's existing HTTP/HTTPS listeners. The added Caddy site proxies `/v2/*` to the API. This bypasses Cloudflare's upload-size cap. Existing `fleetregistry` traffic and old-agent pull credentials remain unchanged. Custom deployments may use another direct HTTPS origin; it must route `/v2/*` to the API without a small request-body limit. Source GET downloads can use the ordinary API hostname.

## Enable a node as a builder

Create `config.json` beside the agent's `agent.json` state file. Keep the existing state file and credentials intact. Example:

```json
{
  "builder": true,
  "max_concurrent_builds": 1,
  "build_cpu": 2,
  "build_memory_bytes": 2147483648,
  "build_disk_bytes": 21474836480,
  "build_cache_bytes": 10737418240,
  "build_reserve_bytes": 5368709120
}
```

Typical directories:

- Linux: `/var/lib/fleet-os` (systemd `fleet-agent.service`).
- macOS: `~/Library/Application Support/fleet-os` (launchd `dev.fleet-os.agent`).
- Windows service installer: `%ProgramData%\FleetOS`; interactive installs may use `%USERPROFILE%\.fleet-os` instead. The service's `--state` argument is authoritative.

Restart the agent's existing supervisor after changing configuration. Building is disabled when the file is absent or `builder` is false. Assignment reservations currently use two CPUs and 2 GiB RAM; keep the configured CPU/memory ceilings at least that large. `build_disk_bytes` may be lowered, down to 1 GiB, for a laptop. The selector honors the advertised per-node budget and concurrent build reservations.

Capabilities refresh asynchronously every 30 seconds. Verify `platform`, `engine_kind`, `effective_cpu`, `effective_mem_bytes`, `can_build`, `max_concurrent_builds`, `build_disk_bytes`, `build_cache_free_bytes`, and `build_disk_reserve_bytes`. Missing Buildx, insufficient free disk, or an unavailable engine disables builder eligibility without delaying heartbeats. OCI platforms supported here are `linux/amd64`, `linux/arm64`, and `linux/arm/v7`.

For Windows, `scripts/install-windows.ps1` installs the supplied binary as `FleetAgent`. Run it elevated with the Windows account that owns the Docker Desktop instance; pair first as instructed by the script. Docker Desktop must be running and reachable by that account. The new update helper waits for the running executable to exit, renames it to `.previous.exe`, installs the staged binary, and starts the service. It never overwrites a running `.exe`. Existing systemd/launchd installation paths are retained.

## Disk policy and cache lifecycle

The reserve is **max(configured reserve, 10% of filesystem capacity)**, calculated independently for the host state filesystem and Docker's Linux filesystem. The default configured minimum is 5 GiB. The tighter remaining headroom governs eligibility. A build refuses to start unless free space covers its entire disk budget **plus** the reserve. Heartbeat fields report the limiting filesystem's free bytes and reserve, so the scheduler can skip it before assignment.

During the Docker solve, the agent polls BuildKit volume usage and both filesystems every three seconds. At or above the build budget, it cancels the solve and returns **failed**, with `disk budget exceeded`. Falling below the free-space reserve also fails the build. An unreadable disk measurement fails closed. This is independent of lease expiry and does not report `timed_out`.

After every build, including a cancelled or failed one, Buildx prunes LRU cache with `--keep-storage` (or its newer `--max-used-space` spelling). The persistent cache cap defaults to 10 GiB, separately from the 20 GiB build budget. For smaller build budgets, the retained cap is additionally bounded to half that budget. The current builder's pruned state is retained for warm reuse. Detached state volumes belonging to older Fleet hashed builders are removed; unrelated volumes are excluded. Dangling daemon images are pruned only with Fleet's ownership label. Builds use `--push`, so they do not load application images into the daemon image store. Concurrent active builders retain their own bounded states until completion.

**Limitations:** this is a monitored budget, not a filesystem hard quota. Writes can overshoot between polls. Docker Desktop's VM disk image can grow without shrinking automatically after pruning. The host free-space check protects the state filesystem; place the state directory on the same filesystem as Docker Desktop's VM disk if you relocate that VM. BuildKit GC cannot remove in-use records. A failed cleanup is surfaced as a build failure rather than a successful cached build.

A trusted BuildKit image is used for a read-only, network-disabled engine disk probe. Its first use may require pulling `moby/buildkit:buildx-stable-1`. Builders remain unavailable until that probe succeeds. Fleet never runs a global Docker system/volume prune.

## App platforms and secrets

```yaml
services:
  web:
    build: .
    platforms: auto
    placement_constraint:
      arch: arm64
    allow_emulation: false
    build_args:
      NODE_ENV: production
    build_secrets:
      - NPM_TOKEN
```

`platforms: auto` takes distinct platforms of all healthy, placement-eligible nodes, including failover candidates. An explicit list such as `[linux/amd64, linux/arm64]` requests those platforms. Placement checks the image manifest, architecture constraints, anti-affinity, effective CPU/memory, and build reservations. Execution emulation requires `allow_emulation: true` and a new agent capable of requesting the platform; it is independent of the builder QEMU fallback flag. Docker Desktop deployments reject host networking and bind mounts; use named volumes. Fleet currently rejects host networking globally because its managed networking contract does not support it.

Build secret names resolve through Fleet's existing encrypted secret store. Values are materialized in private temporary files and passed only using BuildKit `--secret`. Do not put credentials in `build_args`, or deliberately copy a mounted secret into an image layer. Build logs redact the assigned credential/secret values. The dedupe key includes a keyed digest of build inputs so changing a secret invalidates an earlier output without storing the secret in `build_jobs`.

## Orchestration and protocol

One job is created per platform. Selection requires an online WSS connection, explicit builder opt-in, platform compatibility, free CPU/memory/disk, and a concurrency slot. Native builders win; warm affinity, CPU/disk headroom, observed load, and reliability rank candidates. Build reservations participate in ordinary workload placement. Failure to find a builder is immediate and names the required platform.

Protocol version 1 uses `build.assign`, `build.cancel`, `build.ack`, `build.renew`, `build.log`, `build.result`, and `build.receipt`. Every message has a job ID and attempt. Agent duplicates are acknowledged idempotently; reconnect replays actual running attempts and unacknowledged results. The control plane fences node identity, attempt, active status, and lease. Leases last 45 seconds and agents renew every 10 seconds. An expired attempt retries on another eligible builder, at most twice. Orphans after a control-plane restart fail clearly rather than remaining running indefinitely. Orchestration follows the repository's existing single-control-plane/in-memory tunnel ownership model.

GitHub sources use a freshly minted repository-scoped, contents-read installation token to fetch the exact commit. Manual source builds must supply an uploaded context (as `fleet deploy` does), or use the repository deploy path; the shared build workdir is never accepted as an implicit source tree. Uploaded sources use an expiring HTTPS grant bound to the job, attempt, and node, with a SHA-256 integrity check. Temporary archives are removed when the build finishes. Grants stop working when an attempt ends, even before their signed expiry.

Registry uploads use an HMAC-signed, short-lived Basic password scoped to one app repository and active attempt. The gateway holds upstream credentials, rejects cross-repository mounts and manifest deletion, and rewrites upload locations back to itself. Upstream registries that redirect blobs to external object storage are not supported by this minimal gateway; such redirects fail clearly. Existing htpasswd registry auth remains intact for normal pulls and the local fallback.

Multi-platform jobs reuse the existing platform grouping and registry-only `imagetools create` approach. Deployments and agent desired state carry immutable digest references. Repeated successful input/platform builds reuse the recorded digest. Registry garbage collection must retain referenced digests; cache lookup does not currently revalidate externally deleted images.

Build output uses the existing Redis/SSE log stream consumed by `fleet logs --follow`. Deployment progress identifies the selected builder and QEMU fallback. Cancel with authenticated `POST /services/:serviceId/builds/:deploymentId/cancel` while queued/building/pushing. Cancellation is durable and cannot be overwritten by a later phase update. No new CLI release is required for existing log streaming.

## Migrations and rollback

Migrations `0024_agent_build_jobs`, `0025_build_inputs`, and `0026_builder_disk_reserve` are additive. They add job storage, optional engine metadata, builder capabilities/reserves, service platform constraints, and build-input configuration. Omitted old-agent fields remain valid; existing v0.2.4 agents default to `can_build=false` and continue normal workload reconciliation. Their legacy architecture is used only for native execution eligibility, never to infer builder capability.

Before a future production migration, take an external Postgres backup using the repository's deployment procedure. This PR only applies migrations to a disposable local test database and CI.

To roll back operationally in a later deployment: cancel/drain delegated jobs, set `BUILD_MODE=local`, and restart the control plane with the previous known-good image/config. Retain the additive columns/tables; do not down-migrate live data. Restore the earlier agent binary if necessary and disable `builder`. Existing immutable images and old-agent workloads remain available. No production rollback command has been executed in this task.

## Verification in this branch

- Full control-plane/CLI/dashboard typechecks and tests; dashboard and website builds/tests; Go tests and `go vet`; `git diff --check` before each commit. The repository has no JavaScript lint script; no check was disabled.
- Database-backed tests cover assignment, identity/attempt fencing, lease retries, cancellation, dedupe, builder opt-in, and absence of eligible builders.
- Mixed-platform planning, manifest filtering, emulation opt-in, CPU reservations, disk reserves/concurrency, and anti-affinity tests.
- Actual HTTP gateway tests cover scoped source downloads, cross-repository denial, upload streaming, upstream credential isolation, and terminal-attempt revocation.
- Go tests cover platform normalization, Windows-container refusal, source traversal/link rejection, redaction, duplicate/cancel fencing, disk preflight, monitor cancellation, and scoped cleanup.
- Reproduce the local cache integration check with `bash agent/scripts/test-build-cache.sh` (requires Docker, Buildx, Python 3, and OpenSSL).
- Local macOS Docker Desktop: three scratch-image builds on a disposable BuildKit worker; pruning to a 1 MB cap retained 12,288, 4,096, and 4,096 bytes respectively. No images were published; the worker was removed.
- Cross-compilation: Linux amd64/arm64/armv7, macOS amd64/arm64, Windows amd64 at agent v0.3.0.

Not verified here: Windows Service/WSL2 execution or Windows in-place update; macOS launchd replacement/re-registration; production WSS/registry/DNS routing; GitHub App token exchange against a real installation; QEMU runtime; a complete multi-node delegated deployment and manifest rollout. These remain for the separately authorized deployment/E2E prompts. Cross-compilation is not evidence of those runtime checks.
