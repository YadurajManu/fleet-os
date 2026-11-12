# First external deployment issue triage

Reviewed 2026-11-11. There are **25 reports**, numbered in their original order below; the source did not assign actual IDs. Original report: [first-user-issue-report.txt](first-user-issue-report.txt).

“Present” means confirmed by source inspection, not reproduced on a live fleet. “Pending” requires further investigation. “Existing” means implementation exists locally; deployed-version verification is still needed. The earlier reliability release was deployed; see the production verification section. The current developer-workflow batch is local and not yet deployed.

| ID | Report | Status / next action |
| --- | --- | --- |
| F-001 | No fleet discovery | Fixed locally: `fleet use` lists accessible fleets and marks active selection; JSON available. |
| F-002 | Malformed pairing token called missing | Implemented locally: distinct missing, malformed, invalid, expired and already-used pairing errors with recovery advice. |
| F-003 | Explicit pairing token ignored with saved state | Implemented and validated locally: explicit pairing tokens conflict with saved identity before upgrade/network work. Existing credentials are kept; ordinary restarts resume normally. |
| F-004 | Node rename missing | Implemented locally: CLI/API and dashboard rename with format validation, database uniqueness and audit records; node identity is preserved. |
| F-005 | Re-pair creates duplicate hostname | Implemented locally: duplicate hostnames are refused. Explicit admin-authorized replacement tokens preserve node identity and pinned services, rotate credentials and reject a connected old agent. |
| F-006 | Disk reserve excludes laptops | Implemented locally: automatic reserve is capped at 10 GiB on host and engine independently, while explicit higher configured reserves remain enforced. Disk budget and monitoring safeguards are preserved. |
| F-007 | Empty secret import aborts | Fixed locally: selected empty and whitespace-only values skipped with key/line warning, including dry runs; all-empty imports make no requests. Parser keeps empty values intact. |
| F-008 | Secret clone missing | Implemented locally: CLI/API and dashboard copies across authorized fleets and fleet/service scopes. Both source and destination require secret-write permission; cross-fleet copies audit both sides. Existing values are preserved; no values are returned. |
| F-009 | Dockerfile targets unsupported | Implemented locally: build accepts context/dockerfile/target/args objects and legacy strings. Settings persist through migration 0033, manual/Git builds, cache identity and delegated/local runners. Old builders cannot silently ignore targets. |
| F-010 | Reconcile error hidden until rollout timeout | Implemented and validated locally: deployment-specific errors reach progress, explain, dashboard and history even without containers. Permanent image errors fail immediately; transient structured errors get a retry grace. Recovery clears errors. |
| F-011 | Bare Postgres digest reference | Verified by digest qualification regressions for bare Postgres and Alpine references and registry ports. Existing implementation retained; no new image transformation needed. |
| F-012 | AI provider rejects configured model | Reproduced live on 2026-11-12: OpenRouter returns 404 because the configured Nemotron free model is retired. Local fixes add explicit-model validation, credential-safe recovery advice, no model-error schema retries and prompt-free model discovery. Operator must select an accessible model; production settings unchanged. |
| F-013 | Oversize upload returns HTML 413 | Implemented locally: additive .fleetignore, compressed-size enforcement during packaging and before transfer, near-limit warnings, configurable proxy-safe limit, and actionable HTTP 413 errors. Excluded directories are never silently exposed to include a Dockerfile. |
| F-014 | Image inspection crashes plan | Implemented and verified locally: fallback preserves the original tag and returns compatibility warnings in previews/deploy responses. Warnings persist on deployment history and render in CLI/dashboard. Raw registry errors stay out of user-facing warnings. |
| F-015 | Two-core builder starved | Implemented and verified locally: CPU budgets reflect available capacity and configured concurrency, capped at two cores. Capability-gated millisecond shares support fractional CPU; legacy agents require whole-core shares. Zero CPU and insufficient memory are refused. |
| F-016 | Transient du failure kills build | Fixed locally: retry failed du measurements up to three attempts within existing timeout; persistent errors and invalid sizes still fail closed. Disk budget and reserve checks remain enforced. |
| F-017 | Logs unavailable without active node | Implemented and validated locally: shared authorized log reader falls back to exact-attempt build output and durable failure evidence without an active node, including streaming and AI tools. |
| F-018 | Explain repeats opaque disk error | Implemented and validated locally: explain includes observed evidence and actionable advice for short failures and pending rollouts, including when AI is disabled, unavailable or limited. |
| F-019 | One-off exec/task missing | Implemented locally: fleet run executes a bounded temporary container with the service image, resolved environment/secrets and private network. Includes role/fleet checks, audit metadata, exit status/output, cancellation/timeout cleanup and restart/reconnect reaping. Persistent service volumes are not mounted. |
| F-020 | Build secret injection unavailable | Implemented locally: service page lists required build-secret names; manual/Git deploys preflight missing build keys before creating builds; import includes build-only secrets and inherited defaults. BuildKit mount guidance is provided. |
| F-021 | Shared monorepo builds wrong stage | Implemented locally with F-009: worker and gateway can select their own Dockerfile stage, including through Compose imports; distinct targets cannot reuse an incorrect cached result. |
| F-022 | BuildKit memory too restrictive | Implemented locally: removed fixed 2 GiB BuildKit assignment. Each build receives 75% of its uncommitted memory share after dividing capacity among configured concurrent slots. Regression checks cover low and high memory; no real OOM workload reproduced. |
| F-023 | Setting dozens of secrets cumbersome | Implemented locally: manifest-selected import honors service scope and build-secret declarations, previews key names, skips empty values and reports completed/pending keys with a safe retry selection after partial failure. |
| F-024 | Cannot reattach deployment progress | Implemented locally: fleet deploy attach <service> [--deploy <id>] follows the exact attempt through existing progress APIs. Reattachment performs GET requests only; superseded/failed attempts stop with a reason. |
| F-025 | Status hides useful telemetry | Implemented locally: verbose CLI reports tunnel state, disk availability and last runtime errors; stale or missing measurement ages suppress live resource readings. |

## First batch validation

- CLI: 199 tests pass, including two new regression tests; typecheck passes.
- Agent build package tests pass, including retry recovery, persistent measurement failure, invalid and overflowed sizes, existing budget cancellation and scoped cache pruning.
- No live deployment, Docker build or provider request performed.

## Order for remaining work

The developer-workflow batch below implements F-006/009/013/019/021/024 locally.
Release it with migration 0033 and matching server, CLI and agents after review.

1. Pairing messages and detailed current status (F-002/025).
2. Node rename and authenticated replacement, secret cloning (F-004/005/008).
3. Investigate provider configuration and build memory allocation using actual failure evidence (F-012/022).
4. Verify existing image qualification, inspection fallback, builder selection and build-secret discoverability (F-011/014/015/020); assess remaining bulk-secret friction (F-023).

## Second batch: F-003, F-010, F-017, F-018

Historical status at implementation: files only. This batch was subsequently validated and deployed; see production verification below.

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

## Developer-workflow batch — local implementation

Scope: F-006, F-009/F-021, F-013, F-019 and F-024. These changes are **committed locally as separate fixes, not published or deployed** in this batch. Push status is reported separately; committing does not change production. Other open reports remain open.

Migration 0033 adds build Dockerfile/target settings and explicit node feature capabilities. Matching server, CLI and agent releases are required. Existing manifests remain valid; an older builder is refused for a targeted build rather than silently building the final stage. Existing automatic agent upgrade policies are unchanged.

Validation includes full control-plane, CLI and Go suites; typechecks; Go race detection and vet; isolated Postgres/Redis migration; and real Docker checks. The real Buildx check selected a worker stage from a custom Dockerfile and verified a build-argument label. The real task check verified private-network connectivity, environment injection, a nonzero exit code, removal after completion, and cancellation/removal of an actually running process. Final validation: control plane 646/646 tests, CLI 211/211 tests, dashboard 27/27 tests; all three production builds and dashboard typecheck pass. All Go package tests, targeted race checks and go vet pass; agent binaries cross-compile for Linux, macOS and Windows on amd64/arm64. The existing stateful test now awaits asynchronous deployment preparation before inspecting node payloads, removing its timing race. Registry credentials are regression-tested against public task images, and task cleanup refuses foreign containers.

Task limits: two simultaneous tasks per node, 60-second default timeout (1–600 seconds configurable), the service memory limit, and the last 200 output lines capped at 256 KiB. Tasks use the latest available deployment artifact and current resolved service environment, without mounting persistent service volumes. Commands/output/secret values are not written to audit metadata.

The default compressed upload limit is 95,000,000 bytes; FLEET_MAX_UPLOAD_BYTES can set the actual self-hosted limit up to 256 MiB. .fleetignore adds exclusion patterns to .dockerignore; negated ! patterns in .fleetignore are explicitly rejected. A custom Dockerfile inside an excluded directory is reported before upload rather than exposing the directory's other files. Existing .dockerignore negation behavior is unchanged.

Native Windows runtime and production execution of the new protocol remain unverified. Temporary test resources were isolated from production and removed after validation.

## Setup and operations batch — 2026-11-12

F-002/004/005/008/022/025 are implemented and committed locally; they remain
unpushed and undeployed. Migration 0034 stores the authorized replacement node
on a single-use pairing token. Do not replace a stateful node before restoring its
local data: identity preservation does not transfer volumes. Secret cloning is
limited to scopes in one authorized fleet and never overwrites destination values.
BuildKit memory now scales with eligible capacity; this removes the confirmed
hard-coded limit but does not guarantee every application's build will fit.

Validation: server 650/650 tests, CLI 212/212 tests and dashboard 27/27 tests pass. Typechecks pass for all three packages, and production builds pass. Migration 0034 applied successfully in the isolated test database. This batch was committed at the operator’s request; no push or deployment was performed. Interactive browser usability,
real replacement hardware and a real memory-intensive build remain unverified.

## AI and secret setup batch — 2026-11-12

This batch is committed locally and remains unpushed and undeployed. Provider compatibility is
covered for Groq and OpenRouter through the shared client. No automatic paid
failover or daily-limit bypass is introduced. One bounded live request reproduced
the current OpenRouter model rejection; no production configuration was changed.
See ai-provider-setup.md for model discovery and activation requirements.

Validation: 657 server tests, 214 CLI tests and 27 dashboard tests pass; typechecks and production builds pass. The graph and wiki were refreshed, and isolated Postgres/Redis test services were removed after validation. A replacement
provider/model has not been activated; interactive UI and new Groq credentials
remain unverified.

## Release preparation follow-up — 2026-11-12

Production AI is restored with baidu/ernie-5.5-flash-preview:free after bounded,
zero-cost-reported checks. Only the model environment setting changed; the
application image stayed unchanged and healthy. Code changes remain local.
See release-readiness-0.27.0.md for versions, real browser/agent/Buildx checks,
rollback details and remaining release gates. Native-agent replacement used two
isolated state directories on one machine, not two physical machines.

## Five remaining frictions — 2026-11-12

All five follow-up fixes below are implemented and committed locally, unpushed
and undeployed. Source edits used the file-editing tool; commands were limited
to inspection, builds, tests and isolated test-resource management.

| Follow-up | Status and regression evidence |
| --- | --- |
| Ambiguous node IDs | Exact ID/name wins; ambiguous prefixes list candidates and stop before mutations. CLI regression verifies only GET requests occur. |
| AI retry timeout | One absolute deadline spans rate-limit backoff and reasoning/schema degradation. Regressions verify no retry is started outside the original budget. |
| Fixed build CPU | Free CPU is divided among configured slots and capped at two cores. New agents enforce fractional millisecond shares; older agents get whole cores only and cannot silently ignore fractional limits. Selection, wire assignment and agent boundary tests pass. |
| Cross-environment secrets | CLI and dashboard choose authorized source/destination fleets and service scopes. Both require secret-write permission, both sides are audited, and existing values are preserved. API tests cover missing access, viewer denial, wrong scope, decryption of the copied envelope and overwrite refusal; UI test checks the request contains IDs and names, never values. |
| Hidden inspection warning | Placement previews and deployment responses warn about unverified image compatibility. Migration 0035 adds durable deployment warnings; CLI plans and dashboard preview/history display them. API tests verify preview, response and persisted history evidence. |

Validation: 663 server tests, 215 CLI tests and 28 dashboard tests pass. All
typechecks and Go package tests/vet pass. A real BuildKit container was inspected
with CpuPeriod=100000 and CpuQuota=25000, confirming 0.25 CPU enforcement.
New Go files/edits pass the formatting check without a formatting-write command.

Migration 0035 adds node CPU capability and deployment warning storage. Matching
server, CLI and agent updates are required; previously prepared release artifacts
must be regenerated before publication. Production and its AI configuration were
not changed during this follow-up. Real multi-node saturation and native Windows
runtime remain outside this validation.

## Agent memory budget negotiation — fixed locally

The agent now reports its configured build_memory_bytes ceiling on registration
and heartbeats. Migration 0036 persists it, with a safe 2 GiB legacy default.
The server assigns the smaller of that ceiling and 75% of uncommitted engine
memory per configured slot. Progress displays the budget, ceiling and configuration
guidance before dispatch. Invalid low ceilings are filtered out before assignment.

Coverage includes registration/heartbeat persistence, legacy fallback, actual
assignment payloads at 2/3/16 GiB ceilings, free-memory limits, and Go report tests.
A real Docker-backed agent executor check accepts negotiated limits at 2 and 3 GiB
through platform validation, and rejects one byte over the configured ceiling.
It intentionally stops before registry/source/build execution; it is not a new
end-to-end registry push test. The previous 3 GiB Buildx test remains separate.

Validation: 665 server tests pass, along with the server build, all Go tests/vet,
the Docker-backed executor check and six release-target agent builds. Registration
and heartbeat tests cover configuration changes and downgrade to the legacy ceiling.
This fix is committed locally; no push or deployment. Migration 0036 and matching
server/agent updates are required. Existing prepared artifacts need rebuilding.
