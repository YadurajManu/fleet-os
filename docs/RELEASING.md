# Releasing Fleet OS

Fleet has independently versioned components. A tag marks source; a GitHub Release adds notes and downloadable artifacts. The CLI is distributed through [npm](https://www.npmjs.com/package/@yadurajfleetos/cli). GitHub Packages is a separate registry and is not required to install the CLI.

| Component | Tag | Distribution |
| --- | --- | --- |
| CLI | `cli-vX.Y.Z` | npm package and matching GitHub release notes |
| Agent | `agent-vX.Y.Z` | GitHub release with platform binaries and `SHA256SUMS` |
| Control plane / dashboard / website | Deployment revision | Compose deployment; no standalone package |

Before a CLI release, run its build, typecheck, and tests, inspect `npm pack --dry-run` for unwanted files, and confirm the version is new on npm. Publish from a clean checkout, then verify the published version and executable. Do not publish the same version twice. Tag the commit containing the published package version and write release notes describing user-visible changes and compatibility.

Before an agent release, run `go test ./...`, `go vet ./...`, and `make dist` in `agent/`. Verify every file against `agent/dist/SHA256SUMS`. Attach the Linux arm64, armv7, and amd64; macOS arm64 and amd64; and Windows amd64 binaries plus the checksums. Mark a release as a prerelease while native Windows behavior remains unverified, and state that limit in its notes.

Publishing a GitHub agent release does **not** change installed agents. The agent upgrade check reads the control plane's `/install/SHA256SUMS` and only upgrades where the effective `agent_auto_upgrade` policy is enabled. A node override can enable a single canary or pause a node; otherwise it inherits the fleet switch. Changing the control-plane-served binaries or enabling that setting is a separate rollout. Keep the previous agent binary and deployment revision available for rollback.

For a Docker Compose server, use `sudo ./deploy/upgrade.sh check` followed by `sudo ./deploy/upgrade.sh apply` from the repository root. The guarded update and rollback flow is documented in [Updating Fleet OS](updates.md). Run `fleet updates` on an operator machine or open Settings → Updates to see the running components.
