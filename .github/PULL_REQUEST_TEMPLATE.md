<!--
Thanks for the patch! Answering the sections below saves a round trip.
-->

## What changed, and why it was wrong before

<!-- One paragraph. The same thing a good commit message says. -->

## Subsystems Touched

- [ ] `agent` (Go — internal telemetry, docker engine client, tunnel)
- [ ] `control-plane` (TypeScript / Fastify — scheduler, API, ingress, auth)
- [ ] `cli` (TypeScript — command line parser & terminal output)
- [ ] `dashboard` (React 19 / Vite — UI, cluster visualizer, monitors)
- [ ] `docs` / `manifest` (Documentation, schemas, deployment scripts)

## How I know it works

<!--
Which suite did you run, and what does the new test assert? For a bug fix,
the test should fail on `main` and pass here — say so if you checked.
-->

- [ ] Added or updated an automated test that fails without this change
- [ ] Ran the local test suite for the affected component(s)
- [ ] Manually verified on live hardware (`arm64` / `amd64`)

## Anything that needs saying

<!--
Migrations, a changed default, a new environment variable, or anything that
alters behavior for an existing fleet. Write "nothing" if there is nothing.
-->
