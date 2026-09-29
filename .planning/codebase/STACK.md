---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS stack

**Analysis Date:** 2026-09-29

- `cli/` is a Node.js TypeScript ESM package. `cli/package.json` builds with `tsc` and uses `yaml` for manifests.
- `control-plane/` is a Node.js TypeScript ESM Fastify API. `control-plane/package.json` lists Drizzle ORM, PostgreSQL, Redis, WebSocket, Zod, and auth packages.
- `agent/` is a Go 1.24 agent; `agent/go.mod` lists WebSocket, Windows pipe, and PTY dependencies.
- `dashboard/` is React 19, React Router 7, Vite 8, and Tailwind 4 (`dashboard/package.json`).
- `www/` is a React/Vite marketing site with Three.js, motion, and prerender scripts (`www/package.json`).
- `deploy/docker-compose.yml` runs production services; `deploy/caddy/Caddyfile` configures ingress.
- Each JS package has its own lockfile; there is no root package workspace.
- `agent/Makefile` builds cross-platform executables.
- `control-plane/.env.example` and `deploy/.env.example` document runtime configuration.
- Main source roots are `cli/src`, `control-plane/src`, `agent/cmd` and `agent/internal`, `dashboard/src`, and `www/src`.
- CLI entry is `cli/src/index.ts`; API entry is `control-plane/src/index.ts` and `control-plane/src/server.ts`.
- Dashboard entry is `dashboard/src/main.tsx`; marketing entry is `www/src/main.jsx`.
- Tests use Node's test runner for TypeScript and JavaScript; Go uses `go test`.
- CI workflows are defined in `.github/workflows/ci.yml`.
- The build runner supports delegated agent BuildKit and local Buildx (`control-plane/src/build/`).
- Drizzle migrations live in `control-plane/src/db/migrations/`.
- GitHub source checkout is in `control-plane/src/git/checkout.ts`.
- Local upload archives are made in `cli/src/archive.ts` and extracted by `control-plane/src/build/context.ts`.
- Deployment and placement API routes are in `control-plane/src/api/services.routes.ts`.
- Operator and developer setup is described in `README.md` and `docs/ARCHITECTURE.md`.
