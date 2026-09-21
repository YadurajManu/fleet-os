# CLI experience and native Windows pairing

## What's changed

- Bare `fleet` shows compact onboarding; `fleet --help` retains the complete reference.
- `fleet <command> --help` filters command help. `fleet nodes pair --help` explains target selection, credentials and waiting.
- Routine commands use a compact Fleet/fleet-name header. Descriptions use the terminal foreground, not faint gray. Small terminals stack descriptions and table records; commands and URLs remain copyable.
- `--color auto|always|never`, `--ascii`, `--no-animation` control presentation. NO_COLOR disables automatic colors. Non-TTY output and CI never animate. Fonts/background remain under the user's terminal settings; no special font is required.
- Deploy/up track the returned deployment ID. An old running release cannot satisfy the new deploy. Historical estimates are labeled, not shown as measured percentage completion. Missed phases say “not observed.”

## Pair another machine

```sh
fleet nodes pair
fleet nodes pair --target windows --shell powershell
fleet nodes pair --target macos
fleet nodes pair --target linux
fleet nodes pair --target git-bash
```

The picker describes the **target**, not the generator's operating system. Automation must pass `--target`; it does not prompt or wait. `--no-wait` prints the command and returns. Interactive watching defaults to 600 seconds; `--timeout` accepts 1–1800 seconds. `--json` returns the receipt/command without waiting: it contains a credential and must not be logged or shared.

Run the generated command on the target. Ctrl+C on the originating CLI only stops watching. The server correlates the receipt with the exact node that consumed the token. Registration alone, another node's heartbeat or stale telemetry is not success. A first heartbeat with Docker unavailable is reported as incomplete readiness.

## Windows prerequisites and behavior

Use Windows PowerShell 5.1 or PowerShell 7 as Administrator under the account that runs Docker Desktop. Have Docker Desktop running in **Linux containers** mode. The current Windows artifact is amd64; Windows ARM64 is explicitly refused until packaged/verified. Git Bash remains an advanced compatibility path, not a prerequisite.

The installer downloads the binary and SHA256SUMS over HTTPS from your own control plane, requires a unique matching checksum, then registers using a process-scoped pairing environment variable. The credential is not stored in Windows Service arguments. The checksum validates integrity against the trusted control plane; it is not an independent publisher signature.

For a new service, Windows asks for the Docker Desktop account's password (not its Hello PIN). Credentials are passed through PSCredential to service creation, not printed. The account needs Windows “Log on as a service” rights; organizational policy may require an administrator to grant them. Docker Desktop must remain available to that account; service startup does not prove Docker or a remote heartbeat is healthy.

Execution policy is not changed automatically. If organizational policy blocks scripts, use an administrator-approved signing/installation process. Do not permanently weaken policy to bypass the error.

State is stored under `%ProgramData%\FleetOS`, restricted to Administrators and the service account. Reinstall preserves agent.json/config.json and the previous binary at fleet-agent.exe.previous.exe. The installer verifies local service startup; the originating CLI verifies the remote heartbeat. Reinstall of an already paired node deliberately does not consume a new token—stop the new receipt watcher and verify the existing node with `fleet nodes` / `fleet doctor`.

If installation fails after replacement, it attempts to restore the old binary/service path and restart a previously running service. A successfully registered identity is retained even if service creation fails, so a retry can reuse it. No unattended rollback can guarantee recovery from disk/permission failure; inspect the local service and backup if recovery itself errors.

### Existing Git Bash installation

The installer refuses to create a duplicate node when `%USERPROFILE%\.fleet-os\agent.json` exists but ProgramData has no identity. To migrate deliberately:

1. Record the current agent executable, startup method and state directory. Back up that entire state directory privately, including agent.json/config.json; do not paste their contents into logs.
2. Stop **only that legacy agent process** using its verified PID and disable its old startup entry if present. Leave application containers running.
3. As the same Docker Desktop account, copy the existing state directory contents to `%ProgramData%\FleetOS`. Preserve the original directory and binary for rollback.
4. Run the PowerShell installer. It verifies the saved control-plane URL and reuses the identity without consuming a token.
5. Confirm the original node ID/name returns in `fleet nodes` and `fleet doctor`, and that application containers remain healthy. Roll back by stopping/removing the new FleetAgent service and restarting the recorded legacy executable with the original state if necessary.

## Control-plane rollout and compatibility

Deploy the matching control plane before distributing this CLI's native Windows pairing / deployment-wait functionality. Compose now mounts install-windows.ps1 beside install.sh. Custom deployments must mount it there too. No database migration is needed: pairing_tokens already has consumed_by_node_id.

New APIs:

- `GET /install/windows.ps1`: public installer; no embedded credentials.
- Pair-token response adds `pairing_id` and `api_url`; existing `install_command` and token fields remain compatible.
- `GET /fleets/:fleetId/nodes/pairings/:pairingId`: requires node.pair permission; pending/expired/registered/connected/removed, minimal node capabilities, no credential fields.
- `GET /services/:serviceId/deployments/:deploymentId`: service-read authorization and exact service/deployment match; progress is included only for the requested deployment.

Older control planes still support the existing shell command. Missing receipt tracking is reported as unverified; native PowerShell pairing requires the new server. Exact deployment lookup errors must not be mistaken for success. No agent protocol/version change is required.

Rollback: return to the previous CLI package and control-plane image together; the added APIs and Compose mount are additive. The old shell installer remains available. Do not roll back or erase agent identities as part of a CLI rollback.

## Verification and release

Automated checks cover description widths (40/80/120), target quoting, registration versus heartbeat, stale/unrelated heartbeats, permission denial, expiry, exact deployment lookup and old-running/new-failed behavior. CI parses the installer in both Windows PowerShell and PowerShell 7. Parsing does **not** verify service installation or Docker Desktop access.

Manual gates before advertising Windows as verified:

- Fresh install on Windows amd64 with Docker Desktop: verify checksum, service account, matching node ID and first heartbeat.
- Reject Windows-containers mode, missing Docker, bad/missing checksum, expired token and insufficient elevation/logon rights.
- Reinstall without changing node identity; failure after replacement restores the previous binary; containers stay up.
- Test PowerShell 5.1/7, execution-policy restrictions, legacy Git Bash migration, service restart and reboot.
- Interactive macOS/Linux pairing; light/dark terminals at 40/80/120 columns; resize during progress; Ctrl+C restores cursor; static/piped output contains no cursor controls; ASCII and NO_COLOR.

No real Windows installation, production pairing, deployment or npm publication is implied by the unit/integration checks. Record actual OS results before release.
