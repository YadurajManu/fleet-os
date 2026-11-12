# Coordinated release readiness — 2026-11-12

Prepared for the requested push; package publication and deployment remain separate:

The current resource-accounting follow-up additionally requires migration 0037.
It persists actual build reservations and durable task reservations, enforces task
CPU quotas, explains rename/manifest recovery, and makes noRetry literal. Current
checks: 668 server, 215 CLI and 28 dashboard tests, Go tests/vet, real Docker task
execution/cleanup and six agent targets. Rebuilt CLI and agent artifacts are in
/tmp/fleet-release-ready; use the final reviewed revision for deployment and CI.

Follow-up note: five additional fixes are now committed locally on top of this prepared
release. They add migration 0035 (CPU capability and durable inspection warnings).
The earlier CLI tarball and agent binaries must be rebuilt from the reviewed final
revision before publishing; the counts below describe the earlier preparation.
Latest follow-up checks are 663 server, 215 CLI and 28 dashboard tests, plus Go tests
and vet. Include migrations 0033, 0034 and 0035 in the server rollout and verify
`build_cpu_millis` on the canary agent before using fractional CPU assignments.

The memory-negotiation follow-up additionally requires migration 0036 and an
updated agent that reports `build_memory_bytes`. Assignment budgets now honor
that configured ceiling as well as available engine memory per slot. Older
reports default safely to 2 GiB. Restart an agent after changing its builder
configuration, then verify its next heartbeat before increasing build budgets.

| Component | Prepared version | Validation |
| --- | --- | --- |
| CLI | 0.27.0 | 214 tests, build, package in /tmp/yadurajfleetos-cli-0.27.0.tgz |
| Control plane | 0.2.0 | 658 tests, typecheck, build; fresh database migrations 0033/0034 |
| Agent | 0.4.0 | Go tests and vet; six Makefile release targets cross-compiled into /tmp |
| Dashboard | bundled with server release | 27 tests, typecheck, build; local browser interaction checks |

Browser checks: renamed a node and observed the saved heading; copied a fleet
secret to a service scope and observed the new row; checked required build-secret
names, dry-run command and secret-store link on the service page. Removed the
optimistic rename label so navigating between nodes cannot reuse the previous
node's renamed label. Replacement was tested with two real native agent
registrations using isolated state directories on the same Mac, not two physical
machines: node ID and pinned service ID were preserved, old cached credentials
returned 401, and new credentials were accepted.

A real Docker Buildx build allocated 2304 MiB within a 3 GiB builder limit. This
exceeds the previous fixed 2 GiB cap. A separate 64 MiB sentinel container remained
running without OOM. The test builder, container and output image were removed.
This is a bounded local check, not a guarantee against starvation for every real
workload or a cross-machine capacity test.

## Production AI configuration only

The operator authorized selecting any free model. OpenRouter's live model list
reported zero prompt/completion prices for baidu/ernie-5.5-flash-preview:free.
It returned structured JSON at reported cost 0, passed the deployed Fleet client
with schema handling, and answered again after the environment switch.

Only AI_MODEL in /opt/fleet-os/deploy/.env changed. The existing control-plane
container was recreated without building or pulling an image; its image ID was
verified unchanged and Docker health became healthy. No new code was deployed.
Environment rollback copy (private, mode 0600):
/var/backups/fleet-os/ai-model-20261112T040711Z.env.

The new local client remembers unsupported reasoning/schema options per endpoint
and model, avoiding repeated compatibility failures. That improvement awaits the
code release. Free-model availability, response latency and quotas remain provider
controlled; no paid fallback was enabled.

## Release sequence and remaining gates

1. Review the full diff, including the earlier local commits and this release-preparation commit.
2. Push only when requested, then check CI for that exact revision.
3. Back up the database and currently served agent artifacts using the existing
   upgrade flow. Keep the previous application image available for rollback.
4. Apply server/dashboard 0.2.0 with migrations 0033 and 0034 and set the reported
   CONTROL_PLANE_VERSION to 0.2.0. Verify health, database/cache, login and status.
5. Publish the verified agent 0.4.0 binaries/checksums; explicitly update a canary
   node and verify its heartbeat, tunnel, build_targets and task_run capabilities.
   Preserve identity files and existing automatic-upgrade policies.
6. Publish CLI 0.27.0 after the server and canary agent support the new paths.
7. Verify a targeted build, task cleanup, exact-attempt attachment and secret
   preflight on the canary before expanding the agent update.

Rollback: restore the previous application image and served agent artifacts using
the deployment backup. Additive schema columns can remain. Do not reverse a node
replacement by restoring revoked credentials; re-enroll through an authorized
replacement flow. Do not assume identity replacement transfers persistent volumes.
If reverting the AI environment, its old model is known unavailable; select another
verified free model rather than treating the backup as a working AI configuration.

Windows runtime, two-physical-machine replacement, production execution of the
new agent protocol and exact-revision CI remain unverified. These are release
checks, not claimed successes.
