# Fleet delegated builds — deployment handover

Updated 2026-09-20. The operator stopped further E2E testing and requested deployment of completed work plus this handover. Do not treat unfinished tests as passed. No npm package, Git tag, or GitHub release was published.

## Code delivered

| PR | Change | Main commit |
| --- | --- | --- |
| #10 | Agent-delegated builds, platform model, scoped registry gateway, monitored disk budget, lifecycle support | baf553c |
| #11 | Preserve digest references in Docker pulls; CLI follows build/runtime SSE logs | 334d984 |
| #12 | Use JSON manifest descriptors supported by pinned Buildx 0.19.3 | f05936b |
| #13 | Paginate GitHub installation repository catalog beyond 100 repos | 320c884 |

All four PRs passed their required CI before merge. Each fix also passed local repository checks before commit. Original checkout: `/Users/sujeetkumarsingh/Desktop/Fleet`, untouched. Release work used `/Users/sujeetkumarsingh/.codex/worktrees/seo-aeo-geo/Fleet`.

## Deployment

Final control-plane code: `320c884b0d7def69ae336d8c50eedbc364df5cf0`; main CI run `35508330033` passed. Final image: `sha256:459580ffb1f4f7045c2c261470cca1416a55c82ee0d3c4ee00735c20a0afa7b5`. Deployed in agent-build mode; startup health check passed. No further E2E tests ran after the operator stopped them.

Control plane: SSH alias `fleet-cp`, `/opt/fleet-os/deploy/docker-compose.yml`, container `fleet-control-plane`. Agent builds use the direct TLS gateway `https://fleetbuilds.plastikworld.xyz`; DNS-only A record points to `13.204.123.171`. TLS verified; anonymous `/v2/` returns 401. QEMU fallback remains disabled. Additive migrations 0024–0026 applied.

Mac: `sayyestoheaven`, launchd label `dev.fleet-os.agent`, version 0.3.0, Linux/arm64 Docker Desktop engine. Registration reports 11 effective CPUs, 8,217,305,088 bytes engine RAM, and builder capability. Pairing state preserved. Only this node was upgraded. No other registered nodes existed in the baseline, so compatibility with other live v0.2.4 nodes was not exercised.

Builder configuration beside `~/Library/Application Support/fleet-os/agent.json`: one build at a time, 2 CPUs, 2 GiB memory, 4 GiB per-build disk, 2 GiB retained cache, reserve max(5 GiB, 10% of filesystem capacity). Automatic upgrades for the active homelab fleet were disabled with explicit operator approval and must remain disabled through prerelease: the server still serves v0.2.4 checksums/binaries, and the updater compares checksums rather than semantic versions. Server distributed binaries were deliberately not replaced.

GitHub App key ownership corrected to container UID/GID 999, mode 0600 retained. No credentials printed or committed.

## Real project

Identified project: `/Users/sujeetkumarsingh/Desktop/MedLifeCycle`, remote `https://github.com/YadurajManu/NoneOfYourBuisness.git`, Aarogya360/MediLifecycle. Original project checkout untouched. Isolated deployment copy: `/tmp/medlifecycle-release-test`; it contains the deployment manifest and frontend Dockerfile used here. The exact manifest and frontend Dockerfile are preserved alongside this handover in `docs/medlifecycle-deployment/`; copy the Dockerfile to `landing_page/Dockerfile` in a fresh project clone. They have not been committed to the original project repository.

New Fleet project `medlifecycle`:

- Frontend: https://medlifecycle.plastikworld.xyz — HTTP 200 observed.
- API: https://medlifecycle-api.plastikworld.xyz/api — HTTP 200 observed.
- Database: `medlifecycle-db`, PostgreSQL, named volume, pinned to sayyestoheaven; no public database endpoint added.
- Frontend digest: `sha256:8ad03fb5c715682c146743b34821201f690c0c57dd8b108c7c514e30077210d2`.
- API digest: `sha256:9a5c5d28434ddac43695fade7daec741afb47221d9437187e8864dc751daf7c7`.
- Project signing/database secrets stored encrypted in Fleet; values excluded from this report.

No pre-existing live project was replaced. Baseline Fleet had no running app deployments; its existing inactive services were preserved.

## Verification performed before testing was stopped

| Item | Result / evidence |
| --- | --- |
| Node registration and launchd upgrade | PASS; v0.3.0 online, expected engine/platform/capabilities, pairing state unchanged |
| Real frontend/backend uploaded-context builds | PASS; Mac build jobs succeeded, images pushed through gateway, digest-pinned containers started |
| Main page and API root | PASS; both HTTP 200 through public routing |
| CLI build logs | PASS after PR11; captured build phases, RUN output, push output |
| VPS build isolation | Process samples showed no buildx/buildkit build process during delegated builds; continuous Docker-event proof not completed |
| Broken Dockerfile | PASS; failed job, prior frontend remained running and HTTP 200 |
| Gateway scoping | PASS; active grant other-repo and cross-repo mount returned 403; source, expired and finished-job credentials returned 401 |
| Large layer | PASS for build/push; 512 MiB incompressible layer, 68.270 seconds total solve+push; conservative throughput 7.50 MiB/s |
| Large-push memory | Samples 215.7–222.2 MiB control-plane memory; continuous peak measurement not completed |
| Cancel mid-build | PASS; job status cancelled; no BuildKit container remained |
| Prebuilt image | PASS after PR12; real PostgreSQL container started from immutable image |
| Private GitHub/webhook source | NOT COMPLETED; test repository created, pagination blocker fixed in PR13; connection/build/token-residue audit pending |
| App registration/login and deeper API flows | NOT RUN |
| Local-mode deployment rollback drill | NOT COMPLETED; mode switches and health were checked, but full local build/deploy drill remains |
| Dedupe, kill/lease expiry, build secret history/log audit, no-builder error | NOT RUN |
| Destructive disk-budget runtime test | NOT RUN |
| Windows service/update runtime | UNVERIFIED; binaries cross-compiled only |
| Multi-arch runtime | SKIPPED; no second builder authorized |

Known CLI issue: a failed redeploy can report “running” based on the previous healthy deployment. Use deployment history/job status to determine the result; do not infer success solely from that message. CLI telemetry also combines host RAM used with engine capacity, displaying an inconsistent RAM ratio; not corrected in this run.

## Resource impact and cleanup

Existing local disposable PostgreSQL/Redis containers stayed running. Backend BuildKit sample: 122.52% CPU and 426.4 MiB RAM within its 2 CPU / 2 GiB limit. Frontend ~15.7 MiB, new PostgreSQL ~23.9 MiB in samples. Host free disk was about 54 GiB after clearing only disposable npm download cache; later sample ~52.5 GiB. Build disk budgets can briefly overshoot between polls; Docker Desktop VM disk does not automatically shrink after pruning.

Large-push and cancellation test services removed. Large image removed from Mac. Registry DELETE is disabled (405), so its exact repository references were moved outside the registry namespace to `/var/lib/registry/fleet-e2e-quarantine/851fe542-0e97-44e0-b053-974c0e929893`; shared blob data remains for scheduled registry GC. No global prune ran.

Remaining test repository: https://github.com/YadurajManu/medlifecycle-fleet-e2e-20260920 (private, real frontend source). It was created for the uncompleted webhook/private-source test; no connection/deployment was made. Local copy `/tmp/medlifecycle-private-source-e2e`. Remove when no longer needed: `gh repo delete YadurajManu/medlifecycle-fleet-e2e-20260920 --yes`.

## Backup and rollback

Verified external custom Postgres archive: `/opt/fleet-os/backups/delegated-builds-20260920T105342Z/pre-deploy.dump` (133,033 bytes; `pg_restore --list` passed). Directory also contains old Compose/env/Caddy files, image/commit metadata and recovery scripts.

Control-plane rollback:

```sh
ssh fleet-cp 'bash /opt/fleet-os/backups/delegated-builds-20260920T105342Z/rollback-control-plane.sh'
```

Destructive database restore, only when actually required (stops API, recreates DB, restores dump and old control plane):

```sh
ssh fleet-cp 'bash /opt/fleet-os/backups/delegated-builds-20260920T105342Z/restore-db.sh'
```

Local-build fallback (helper remains on this Mac):

```sh
bash /tmp/fleet-set-build-mode.sh local
```

Agent rollback:

```sh
bash /tmp/fleet-rollback-agent.sh
```

Old binary: `/Users/sujeetkumarsingh/Library/Application Support/fleet-os/bin/fleet-agent.pre-0.3.0-20260920`. Helper unloads launchd, restores this binary, removes the newly created builder config, and reloads the original plist; pairing state preserved. Durable copies of the mode-switch and agent rollback helpers are included in `docs/medlifecycle-deployment/`; they can be run directly with bash.

GitHub key ownership rollback: `ssh fleet-cp 'sudo chown 1000:1000 /opt/fleet-os/deploy/github-app.pem'` (restores prior unreadable ownership; use only alongside a matching deployment rollback).

DNS rollback: `python3 /tmp/fleet-build-dns.py rollback` (uses the privately saved ID of the record created during this run).

## Release gate and next operator

No npm publication, release tags or GitHub release were created. Do not publish on the basis of this partial test run. Resume the remaining P0 checks explicitly when requested, then follow the release gate: clean main, minor CLI version bump/release PR, package audit, npm authentication/OTP, publication verification, and prerelease agent binaries/checksums. Windows runtime remains unverified. Do not change the server's published agent checksum source or re-enable automatic updates casually; doing so can replace agents beyond the Mac.

Original Fleet edits excluded:

- CLI: package.json; src/commands/auth.ts, backups.ts, doctor.ts, fix.ts, services.ts; src/index.ts; untracked src/suggestions.ts and tests/suggestions.test.ts.
- Website: scripts/generate-og.mjs, scripts/og-card.svg; src/components/Footer.jsx, Founder.jsx, Terminal.jsx; src/lib/pages.js.

Sanitized detailed run log: `/tmp/fleet-delegated-release-run-20260920.md`. Test/build captures in `/tmp/fleet-*` are local working evidence, not a completed release certification.
