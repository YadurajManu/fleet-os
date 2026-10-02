# Changelog

## 0.25.0

- Added `fleet updates` with the running server revision, node agent versions, this computer's CLI version, and the separate update paths. Offline agent versions are explicitly marked as last reported.
- Added `fleet nodes upgrade <name> on|off|inherit` for a one-node canary or pause, with the effective policy shown in `fleet updates`.
- Requires a control plane that reports its Git revision in `/healthz` for the server revision to be shown; older servers appear as unknown. Does not trigger a server or agent update from the CLI.

## 0.24.0

- Added `fleet domains` to manage permanent Fleet URLs, friendly aliases, and DNS-verified custom domains. `check` verifies the direct TLS certificate before a custom domain can become primary. Requires the matching control-plane migration and Caddy direct-TLS ingress.

## 0.23.0

- `fleet changes <service>` previews the exact local build snapshot, including added, modified, and removed files against the last successful release, without uploading source.
- `fleet deploy` and `fleet up` show local snapshot identity, Git context, excluded patterns, manifest comparison, and upload size. The deploy uploads the same archive it previewed.
- `fleet deployments` labels local snapshots separately from Git commits and can show a short note supplied with `--message`.
- Requires the matching control-plane source-baseline API and server-side context hashing. Older releases without hashes report that comparison is unavailable.

## 0.22.0

- `fleet apply` shows available nodes and prompts when a new pinned service needs a node; `--choose-node` can explicitly revisit the choice. The chosen pin is validated and saved to `fleet.yaml` after a successful apply.
- `fleet deploy --choose-node` lists eligible nodes for flexible services. Placement previews now reflect `--node` selections and reject ineligible targets before uploading a build context.
- Apply reports restored pins; a service with deployment history cannot silently move its persistent volume to another node.

## 0.21.1

- `fleet uninstall --force` now explains when Docker cleanup is incomplete because Docker Desktop is stopped, and gives the correct retry command instead of control-plane troubleshooting advice.

## 0.20.1

- `fleet auth login` now connects to the hosted Fleet control plane on a fresh install without asking for its URL. Saved self-hosted profiles, `FLEET_API`, and `--api` still take precedence.
- First-run help and sign-in guidance now show the one-command hosted login.

## 0.20.0

- `fleet status` now resolves the selected fleet before drawing its header, explains degraded state, hides stale resource readings, and shows OCI platform, heartbeat age, agent/runtime capabilities, affected services, recent activity, and state-aware recovery commands.
- Added focused `fleet status --nodes`, `--services`, and `--failures` views, `--since <duration>` activity filtering, and a five-second `--watch` mode.
- Status memory readings now use the Docker engine's effective capacity, matching scheduler decisions on Docker Desktop and constrained engines.

## 0.19.0

- Compact welcome and focused help; responsive descriptions/tables, color/ASCII/static-progress controls.
- Target-aware pairing with native PowerShell installer commands and exact-node heartbeat confirmation.
- PowerShell installation verifies checksums and Docker mode, preserves identity and configures a Windows Service under the Docker Desktop account.
- Deploy/up follow the requested deployment instead of treating a previous running release as success.

Requires the matching control-plane pairing and deployment-detail APIs. Native Windows service/Docker Desktop behavior requires real-machine verification; CI syntax checks alone do not establish support. See docs/cli-experience.md in the repository.
