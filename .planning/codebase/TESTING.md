---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS testing map

**Analysis Date:** 2026-09-29

- `.github/workflows/ci.yml` is the definitive CI task list.
- CLI scripts in `cli/package.json`: `npm run typecheck`, `npm run build`, `npm test`.
- CLI tests under `cli/tests/` use Node's test runner and `tsx`.
- `cli/tests/deployment-identity.test.ts` checks that an old release cannot satisfy a new deploy.
- `cli/tests/deploy-wait.test.ts` checks deployment polling and timeouts.
- `cli/tests/cli.test.ts` covers command behavior and presentation.
- `control-plane/package.json` defines typecheck/build/test scripts.
- Control-plane tests under `control-plane/tests/` run against `.env.test` and apply migrations in `pretest`.
- `control-plane/tests/build-transfers.test.ts` covers registry/build transfer boundaries.
- `control-plane/tests/pairing-status.test.ts` covers pair/heartbeat state.
- `control-plane/scripts/smoke.ts` is a deployed-server smoke runner.
- `control-plane/scripts/e2e-deploy.ts` exercises deployment flow.
- `agent/` uses Go tests and has `agent/scripts/test-build-cache.sh` for cache behavior.
- `dashboard/package.json` defines typecheck, test and Vite build.
- `www/package.json` defines marketing-site test and prerendered build.
- `www/tests/seo.test.mjs` checks generated SEO content.
- Source-hash logic should have a focused test for ignore rules, stable order and changed file categories.
- Deployment baseline API tests should verify failed attempts do not replace the last successful release.
- API permission tests should confirm cross-fleet snapshot data cannot be read.
- Deploy smoke should verify existing apps still route and health remains stable.
- Tests should not depend on a fixed wall-clock timeout shorter than CI load variability.
