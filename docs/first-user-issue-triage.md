# First external deployment issue triage

Reviewed 2026-11-11. There are **25 reports**, numbered in their original order below; the source did not assign actual IDs. Original report: [first-user-issue-report.txt](first-user-issue-report.txt).

“Present” means confirmed by source inspection, not reproduced on a live fleet. “Pending” requires further investigation. “Existing” means implementation exists locally; deployed-version verification is still needed. No production changes have been made.

| ID | Report | Status / next action |
| --- | --- | --- |
| F-001 | No fleet discovery | Fixed locally: `fleet use` lists accessible fleets and marks active selection; JSON available. |
| F-002 | Malformed pairing token called missing | Present: registration groups missing and malformed bearer tokens; split responses and cover HTTP behavior. |
| F-003 | Explicit pairing token ignored with saved state | Implemented and validated locally: explicit pairing tokens conflict with saved identity before upgrade/network work. Existing credentials are kept; ordinary restarts resume normally. |
| F-004 | Node rename missing | Pending: CLI/API rename with uniqueness validation and audit trail. |
| F-005 | Re-pair creates duplicate hostname | Present: registration suffixes names. Hostname alone cannot safely prove machine identity; require authenticated replacement rather than silently claiming another node. |
| F-006 | Disk reserve excludes laptops | Present: max(configured reserve, 10% capacity). Choose bounded automatic reserve while preserving host and engine safeguards. |
| F-007 | Empty secret import aborts | Fixed locally: selected empty and whitespace-only values skipped with key/line warning, including dry runs; all-empty imports make no requests. Parser keeps empty values intact. |
| F-008 | Secret clone missing | Pending: server-side authorized copy; preserve write-only values and fleet/service access controls. |
| F-009 | Dockerfile targets unsupported | Present: build schema is a string. Trace manifest, persistence, context packaging, assignments, agent, CLI and dashboard before adding object form. |
| F-010 | Reconcile error hidden until rollout timeout | Implemented and validated locally: deployment-specific errors reach progress, explain, dashboard and history even without containers. Permanent image errors fail immediately; transient structured errors get a retry grace. Recovery clears errors. |
| F-011 | Bare Postgres digest reference | Existing: `pinnedImage` qualifies bare names with `docker.io/library/`. Verify managed database path and regression coverage. |
| F-012 | AI provider rejects configured model | Pending: current source default differs from reported model. Inspect deployment configuration/provider response; do not guess a replacement model. |
| F-013 | Oversize upload returns HTML 413 | Pending: context ignore support, size boundary handling and readable proxy response. |
| F-014 | Image inspection crashes plan | Existing: deploy image inspection catches failures and proceeds unpinned. Verify plan route coverage. |
| F-015 | Two-core builder starved | Existing: selector accepts 0.5 free CPU or positive free CPU with no active build, and 1 GiB free memory. Verify selection tests. |
| F-016 | Transient du failure kills build | Fixed locally: retry failed du measurements up to three attempts within existing timeout; persistent errors and invalid sizes still fail closed. Disk budget and reserve checks remain enforced. |
| F-017 | Logs unavailable without active node | Implemented and validated locally: shared authorized log reader falls back to exact-attempt build output and durable failure evidence without an active node, including streaming and AI tools. |
| F-018 | Explain repeats opaque disk error | Implemented and validated locally: explain includes observed evidence and actionable advice for short failures and pending rollouts, including when AI is disabled, unavailable or limited. |
| F-019 | One-off exec/task missing | Pending: end-to-end task execution needs authenticated API, agent transport, output, cancellation and CLI. |
| F-020 | Build secret injection unavailable | Existing: `build_args` and `build_secrets` schema, agent BuildKit secret mounts and documentation in `agent-delegated-builds.md`. Verify usability/discoverability; public frontend variables are embedded in client bundles. |
| F-021 | Shared monorepo builds wrong stage | Same root cause as F-009; deliver together. |
| F-022 | BuildKit memory too restrictive | Pending: agent uses assignment memory; inspect control-plane allocation/config before changing resource enforcement. |
| F-023 | Setting dozens of secrets cumbersome | F-007 restores file-based bulk import. Keep values out of argv/shell history; assess remaining batch UX through import. |
| F-024 | Cannot reattach deployment progress | Pending: inspect existing polling/streaming contract and add attach without creating another deployment. |
| F-025 | Status hides useful telemetry | Pending: verbose output should surface current telemetry and errors without presenting stale metrics as live. |

## First batch validation

- CLI: 199 tests pass, including two new regression tests; typecheck passes.
- Agent build package tests pass, including retry recovery, persistent measurement failure, invalid and overflowed sizes, existing budget cancellation and scoped cache pruning.
- No live deployment, Docker build or provider request performed.

## Order for remaining work

1. Validate this batch (F-003/010/017/018); then pairing error messages and detailed status (F-002/025).
2. Context upload and builder resource behavior (F-006/013/022).
3. Build targets and existing build secret UX (F-009/020/021).
4. Node identity/rename, secret cloning, task execution and deployment attach (F-004/005/008/019/024).
5. Verify already-landed fixes and deployment model configuration (F-011/012/014/015).

## Second batch: F-003, F-010, F-017, F-018

Status: **implemented in files; not yet validated or deployed**.

- Agent reports errors with deployment identity and operation; assigned environment credentials are redacted from this new telemetry.
- Control plane checks the authenticated node assignment and active deployment state. Older agents can supply a name-prefixed error only with an exact deployment stage and an unambiguous fleet service; legacy errors alone never terminate a rollout.
- Progress is processed even without containers. Durable failure evidence survives rollout timeouts. Successful stages and promotions clear previous errors; late stage reports cannot change terminal rows.
- Retry grace starts at the first observed error, rather than deployment creation before a potentially long build. Permanent image errors fail immediately; other structured failures receive 90 seconds of retry grace.
- Shared log fallback filters by the latest deployment ID and service, rejects cross-fleet node overrides, and labels retained output. It does not substitute an older healthy release's logs for a failed attempt.
- Explanations include evidence and next steps without requiring a model for short errors. Provider failures and limits also preserve the evidence.
- Explicit pairing conflicts exit with a useful error and preserve saved credentials. Ordinary restarts continue normally.

Static review: all 13 changed TypeScript source/test files parsed successfully using an in-process syntax parser. This is not typechecking, test execution, Go validation or a dashboard render check.

Regression tests added, not executed: agent pairing intent and credential preservation; reconcile identity, recovery and redaction; CLI error progress; retained-log filtering and explanation advice; HTTP no-container reporting, recovery, late reports, node isolation, ambiguous legacy names, retry timing after a long build, and authenticated logs without an assigned node.

Per user instruction, no terminal commands, tests, builds, formatter, graph refresh, git actions or live deployment requests were run for this batch. Earlier passing tests do not validate these changes. Refresh the architecture graph when command execution is permitted.

Release requirement: publish the control-plane, CLI, dashboard and agent changes. Full deployment-scoped reporting requires an updated agent; compatibility with older agents remains conservative. Build-log retention remains 200 entries for up to 24 hours; expired logs cannot be reconstructed.

## Release preparation — 2026-11-11

CLI version: **0.26.1**. Agent release: **0.3.1**. Includes all seven fixes completed in this issue pass: F-001, F-003, F-007, F-010, F-016, F-017 and F-018. Other reports remain open or awaiting verification as recorded above.

Validation after command execution was authorized:

- CLI: 200 tests pass; typecheck and production build pass; package dry run succeeds.
- Control plane: 638 tests pass against isolated local Postgres/Redis; typecheck and build pass.
- Dashboard: 27 tests pass; typecheck and production build pass.
- Agent: all package tests and go vet pass; all six release targets cross-compile.
- Architecture graph refreshed; whitespace checks pass. No schema migration or dependency change is included.

The integration pass corrected the idle-service diagnostic, restored retained-log fallback when a service has no deployment row, updated the security fixture to include real log metadata, and corrected stale rollout/database test expectations.

Production rollout uses the existing backup-and-rollback upgrade script. Agent release files are verified in staging, previous files are backed up, and checksums are switched last. Existing fleet/node automatic-upgrade policies remain unchanged. npm publication is separate: the operator requested the command to publish CLI 0.26.1. Native Windows runtime behavior and a real application build remain outside this validation.

## Production verification — 2026-11-11

Deployed application revision: **7f39da830947e0c11440e5476afc68b15380f491**. Control-plane health reports that revision with Postgres and Redis healthy. Dashboard asset changed from index-DSLSPYw-.js to index-CaTLiLYD.js.

All six agent artifacts were published and their public checksum manifest matches the locally built release. Both installed agents (sayyestoheaven-2 and ip-172-26-11-9) were explicitly updated to **0.3.1**, preserving saved identity files byte-for-byte. Both subsequently reported live heartbeats and connected tunnels. The existing db and cache containers remained running. Fleet automatic agent upgrades remain disabled.

- Server database backup and rollback: /var/backups/fleet-os/upgrade-bCTLJkyy/ (run rollback.sh with sudo on the server if needed).
- Previously published agent files: /var/backups/fleet-os/agent-before-0.3.1-QyYGsEC0/.
- Previous installed Linux agent: /var/backups/fleet-os/installed-agent-before-0.3.1-N1PJ11Hr/.
- Previous installed Mac agent: ~/Library/Application Support/fleet-os/release-backups/before-0.3.1/.

CI run: https://github.com/YadurajManu/fleet-os/actions/runs/43025772846. Control plane, CLI, dashboard, agent, Windows installer, ingress config and upgrade-script jobs all passed. The unchanged marketing job still fails npm audit, as it did on the previous production revision; marketing source/dependencies were not changed in this release.

CLI 0.26.1 is committed and packaged, **not published to npm**. The operator requested the publication command separately. F-001/F-007 client changes require installing that version after publication; the new backend diagnostics are already live. Isolated release-test containers were stopped and removed after validation.
