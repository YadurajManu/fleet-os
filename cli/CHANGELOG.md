# Changelog

## Unreleased

- Compact welcome and focused help; responsive descriptions/tables, color/ASCII/static-progress controls.
- Target-aware pairing with native PowerShell installer commands and exact-node heartbeat confirmation.
- PowerShell installation verifies checksums and Docker mode, preserves identity and configures a Windows Service under the Docker Desktop account.
- Deploy/up follow the requested deployment instead of treating a previous running release as success.

Requires the matching control-plane pairing and deployment-detail APIs. Native Windows service/Docker Desktop behavior requires real-machine verification; CI syntax checks alone do not establish support. See docs/cli-experience.md in the repository.
