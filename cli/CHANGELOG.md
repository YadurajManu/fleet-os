# Changelog

## Unreleased

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
