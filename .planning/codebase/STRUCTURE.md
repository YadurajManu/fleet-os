---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS repository structure

**Analysis Date:** 2026-09-29

- `README.md` introduces the product and links operator/developer documentation.
- `docs/` contains architecture, manifest specification, build guidance and handovers.
- `cli/src/index.ts` is command dispatch; `cli/src/commands/` contains command handlers.
- `cli/src/archive.ts` owns local context packaging and upload.
- `cli/src/api.ts` owns CLI HTTP calls; `cli/src/config.ts` owns local profile loading.
- `cli/src/render.ts`, `cli/src/presentation.ts`, `cli/src/ui.ts` provide terminal rendering.
- `cli/tests/` holds Node test-runner TypeScript tests.
- `control-plane/src/index.ts` starts the API; `control-plane/src/server.ts` registers app routes.
- `control-plane/src/api/` holds route handlers, context and deploy orchestration.
- `control-plane/src/build/` holds context handling, runner implementations and registry transfer.
- `control-plane/src/db/schema.ts` defines Drizzle tables; `control-plane/src/db/migrations/` are ordered SQL migrations.
- `control-plane/src/git/` checks out GitHub source; `control-plane/src/github/` handles installations.
- `control-plane/src/ingress/` routes public application traffic.
- `control-plane/tests/` holds API/integration tests.
- `agent/cmd/agent/` starts the Go process and platform service wrappers.
- `agent/internal/` holds client, Docker, build and runtime logic.
- `dashboard/src/` is the authenticated React app; `dashboard/tests/` is its test root.
- `www/src/` is the landing site; `www/p/` has prerender and social-card scripts.
- `deploy/` contains Compose, Caddy, registry and cloud deployment files.
- `.github/workflows/ci.yml` defines automated verification.
- `.planning/codebase/` is a GSD-generated architecture reference, not runtime code.
