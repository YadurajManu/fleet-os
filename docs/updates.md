# Updating Fleet OS

Fleet has three release tracks. The control plane, dashboard, and website run from one Git revision on your server. Agents run a platform-specific binary on each node. The CLI is an npm package on each operator's computer. Updating one track does not silently update the others.

## Operator flow

1. Run `fleet updates` or open **Settings → Updates**. Both show the running server revision and each node's reported agent version and heartbeat. The CLI command also shows its own installed version; the browser cannot see software installed on your computer. An offline node's version is its last report, not proof of what is currently running.
2. Read the release notes and compatibility requirements. Take a database backup before changing the server. Keep the previous revision and agent binaries available.
3. On the control-plane host, run `sudo ./deploy/upgrade.sh check` followed by `sudo ./deploy/upgrade.sh apply`. The script refuses a dirty checkout or a non-fast-forward update, backs up Postgres outside its container, verifies the archive, records an exact rollback command, builds the new control plane, dashboard, and website, and checks container health. It keeps agent auto-upgrade settings unchanged. Database migrations run on control-plane startup; a code rollback does **not** undo migrations, so migrations must remain backward compatible.
4. Upgrade agents in a canary fleet first. Only opt in a fleet after the control plane serves the intended binaries and `SHA256SUMS`. Agents verify checksums before installing and restart into the new binary. Check the first heartbeat and version on each node before expanding the rollout. The existing fleet-wide switch is deliberately off by default; it is not a per-node rollout controller.
5. Run `npm install -g @yadurajfleetos/cli@latest` on each operator machine, then `fleet --version`. An npm release does not update installed CLIs by itself.

The dashboard presents these as separate tracks because a single “update everything” button would hide three different trust and rollback boundaries. The server cannot safely replace itself from a browser without an independently managed host updater. The host-side script is that updater; it requires local shell access to the server and Docker Compose.

## Rollback and failure handling

The host upgrade command prints and saves a rollback command before replacing containers. If the API health check fails, it immediately restores the previous Git revision and rebuilds the previous server images. It leaves the database backup untouched. Check existing services and node heartbeats after any rollback. To restore data, use the verified `pg_dump` archive with `pg_restore` only after inspecting the migration and data-loss implications; code rollback alone is normally safer.

Agent rollback uses the saved previous binary on the node and its service manager. CLI rollback is `npm install -g @yadurajfleetos/cli@<previous-version>`. Neither is triggered by rolling back the server.

## CI and release checks

Before shipping, run control-plane, dashboard, website, and CLI typechecks, tests, and builds, plus `go test ./...` and `go vet ./...` in `agent/` when agent code changes. CI must be green before deployment. The update script itself is syntax checked in CI. A server deploy passes only when Compose starts and the API health endpoint reports `status: ok`; dashboard and public routes still need an external smoke test because a healthy API does not prove ingress or browser assets work.

## Current limits

- Agent auto-upgrade is fleet-wide and off by default. It does not stage individual nodes, enforce a maintenance window, or roll back a broken agent automatically.
- `/healthz` reports the running Git revision only for deployments that pass `FLEET_REVISION` to Compose; older deployments show `unknown`.
- The update script supports the repository's Docker Compose deployment. Other installation methods need their own updater.
- Postgres schema migrations are forward-only. Keep migrations additive and compatible with the previous server revision; test restores separately.
