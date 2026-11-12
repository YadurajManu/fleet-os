# Fleet OS CLI (`fleet`)

The command-line interface for **Fleet OS** — git-push deploys onto hardware you already own.

## Installation

### Via npm (Global)
```bash
npm install -g @yadurajfleetos/cli
```

### Run Directly via npx
```bash
npx @yadurajfleetos/cli --help
```

### Build and Install from Source
```bash
git clone https://github.com/YadurajManu/fleet-os.git fleet-os
cd fleet-os/cli
npm install
npm run build
npm link
```

---

## Quick Start

For a guided first deploy, run this in a directory where Fleet can create a
`fleet-quickstart` sample folder:

```bash
fleet quickstart
```

It signs in if needed, uses an online node or guides you through pairing one,
then deploys a prebuilt Nginx sample. If it prints a pairing command, run that
one-time command on the target machine while the CLI waits. HTTPS reachability
still depends on ingress and DNS being configured.

### 1. Sign In
```bash
# Hosted control plane (default: https://fleetapi.plastikworld.xyz)
fleet auth login

# Self-hosted control plane
fleet auth login --api https://fleetapi.example.com

# Sign out (clears httpOnly session cookies)
fleet auth logout
```

### 2. Pair a Machine
```bash
fleet nodes pair
```
Run the generated `curl -fsSL ... | sh` command on the machine you want to add to your fleet.

### 3. Check Fleet Status & Health
```bash
fleet status
fleet doctor
```

### 4. Deploy a Service
```bash
# Validate manifest
fleet validate

# Apply services to fleet
fleet apply

# Plan and deploy a service
fleet changes web
fleet deploy web --message "Update home page"

# After editing local files, repeat to deploy the new snapshot.
# No GitHub push is required. The current release stays online during the build.
fleet changes web
fleet deploy web
fleet deployments web

# Roll back to previous healthy deployment
fleet rollback web
```

### 5. Follow Live Logs
```bash
# Stream logs in real-time via SSE
fleet logs web --follow
```

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `fleet quickstart` | Guided sign-in, machine pairing, sample app scaffold, and first deploy |
| `fleet auth login` | Sign in and save secure local session |
| `fleet auth logout` | Sign out and clear httpOnly session cookies |
| `fleet config show` | Show active control plane and selected fleet |
| `fleet use [fleet]` | List accessible fleets and the active fleet, or choose a default fleet |
| `fleet nodes pair` | Generate single-use pairing token for a new node |
| `fleet nodes` | List nodes, status, and resource usage |
| `fleet status` | One-screen overview of fleet health |
| `fleet doctor` | Diagnostic health check across cluster |
| `fleet diagnose <q>` | AI-powered root-cause analysis |
| `fleet apply [file]` | Apply `fleet.yaml` manifest |
| `fleet deploy <svc> [--message <text>]` | Preview the local snapshot, confirm, upload it, then build and roll out |
| `fleet changes <svc>` | Compare the included local files with the last successful release without uploading |
| `fleet updates` | Show server revision, node agent versions, CLI version, and safe update steps |
| `fleet nodes upgrade <name> on\|off\|inherit` | Opt in one agent, pause it, or return to the fleet policy |
| `fleet deployments <svc>` | Show local snapshot or Git identity, changed-file counts, status, node and image digest |
| `fleet domains [svc]` | Show the permanent Fleet URL, attached domains, and verification state |
| `fleet domains add <svc> <host>` | Add a Fleet alias or print the TXT and A/CNAME records for a custom domain |
| `fleet domains check <svc> [host]` | Verify ownership, routing, and HTTPS readiness |
| `fleet domains primary <svc> <host>` | Change the URL used by `fleet open`; pass the permanent Fleet host to restore it |
| `fleet domains rm <svc> <host>` | Remove an additional domain without removing the permanent Fleet URL |
| `fleet logs <svc> --follow` | Live SSE stream of container logs |
| `fleet logs <svc>` | Read the current log tail |
| `fleet restart <svc>` | Restart a service |
| `fleet rollback <svc>` | Roll back to previous deployment |
| `fleet reschedule <svc>` | Force scheduler to migrate service |
| `fleet where <svc>` | Explain scheduler placement and candidate scores |
| `fleet tune` | Compare allocated RAM vs actual memory consumed |
| `fleet events` | Unified cluster event timeline |
| `fleet backup <svc>` | Create on-demand persistent volume snapshot |
| `fleet backups <svc>` | List volume backups |
| `fleet restore <svc> [id]` | Restore volume snapshot |
| `fleet secrets` | List configured secret keys |
| `fleet secrets set <KEY>` | Securely store a credential |
| `fleet import [file]` | Convert a docker-compose.yml into fleet.yaml |
| `fleet init [--ai]` | Scan repository and scaffold fleet.yaml |
| `fleet validate [file]` | Lint and validate fleet.yaml placement rules |
| `fleet open <svc>` | Open public service endpoint in browser |

---

## License

MIT License.
# Pairing and terminal presentation

Run `fleet` for compact onboarding, `fleet --help` for the full reference, and
`fleet nodes pair --help` for target-machine setup. Native Windows pairing uses
PowerShell rather than requiring Git Bash:

```sh
fleet nodes pair --target windows --shell powershell
fleet nodes pair --target macos
fleet nodes pair --target linux
```

Run the generated Windows command as Administrator under the Docker Desktop
account, with Docker Desktop in Linux-container mode. The installer verifies the
download checksum and installs a Windows Service; the originating CLI confirms
the paired node's fresh heartbeat. This requires the matching control-plane
release and published Windows agent binary/checksum. See
[installation details](https://github.com/YadurajManu/fleet-os/blob/main/docs/cli-experience.md).

Use `--no-animation`, `--ascii`, and `--color auto|always|never` to adapt output.
Automatic colors respect `NO_COLOR`; CI and redirected output never animate.
Terminal fonts and backgrounds stay under your control.

Secret imports skip empty or whitespace-only values with a warning and keep importing non-empty values. Use `fleet secrets import .env --all --dry-run` to preview keys without uploading values.

Deployment progress shows the underlying reconciliation error while retries are in progress. Invalid image references fail without waiting for the full rollout timeout. `fleet explain <service>` provides the recorded cause and next steps, including for a pending rollout that has reported an error.

`fleet logs <service>` and `fleet logs <service> --follow` fall back to retained build/deployment output when no container is available. Retained output is labeled; build logs are kept for up to 24 hours.

An explicit pairing token with an existing agent identity now produces an error instead of silently resuming. Existing credentials are preserved. Normal agent restarts continue to use saved credentials.

## Deployment recovery and one-off commands

Reconnect to an existing deployment without starting another build or upload:

```sh
fleet deploy attach web
fleet deploy attach web --deploy <deployment-id>
```

Without an ID, attach follows the latest deployment. A superseded deployment is
a terminal failure; an older running release does not satisfy the selected attempt.

Run a migration or other command in a temporary container using the service image,
current environment, and private network:

```sh
fleet run web --timeout 120 -- npm run migrate
```

Arguments after `--` are passed unchanged. The command uses the latest deployment
artifact and returns the command's exit code. It does not mount persistent service
volumes. Output is returned on completion (last 200 lines, at most 256 KiB). The
default timeout is 60 seconds, configurable from 1–600 seconds. Two simultaneous
tasks are allowed per node. Disconnecting or cancelling stops and removes the
temporary container. This requires matching server and agent task support.

## Keeping source uploads small

Add `.fleetignore` beside `.dockerignore` in the build context to exclude extra
files from Fleet uploads. Patterns are additive; `!` negations in `.fleetignore`
are rejected. Keep the selected Dockerfile outside excluded directories.

The default compressed upload limit is 95,000,000 bytes. Large contexts fail
locally with cleanup advice; proxy 413 responses also explain how to reduce them.
Self-hosted installations can set `FLEET_MAX_UPLOAD_BYTES` on the CLI to their
actual server/proxy limit (at most 256 MiB); this does not raise server limits.

## Recovering nodes and reusing secrets

```sh
fleet status --verbose
fleet nodes rename old-name new-name
fleet nodes pair --replace existing-node --target linux
fleet secrets clone DATABASE_URL --to worker
fleet secrets clone DATABASE_URL --from-service web --to worker --as WORKER_DATABASE_URL
```

Status distinguishes connection state, last reported runtime errors and measurement
age. Stale measurements are unavailable rather than displayed as live capacity.

Stop the old agent before replacement. Run the generated installation command on
a replacement machine without a saved Fleet identity. Replacement preserves the
node ID, name, cordon state and pinned services, and revokes the old credential.
It does not move local data volumes: restore them before starting stateful services.
Restart an already paired agent normally; never re-pair it just to restart it.
A duplicate hostname is refused with recovery instructions.

Secret copying works between fleet and service scopes within the selected fleet.
Values never leave the server, and destination values are never overwritten.
Use another destination key if it already exists. Redeploy affected services after
copying; running containers keep their current environment.
