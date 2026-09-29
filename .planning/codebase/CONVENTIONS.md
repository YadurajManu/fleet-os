---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS conventions

**Analysis Date:** 2026-09-29

- TypeScript packages use ESM and explicit local modules (`cli/package.json`; `control-plane/package.json`).
- CLI commands are grouped under `cli/src/commands/` and registered in `cli/src/index.ts`.
- CLI errors use `CliError` and friendly actionable text (`cli/src/api.ts`).
- CLI terminal output uses shared colors, glyphs and headers (`cli/src/render.ts`; `cli/src/presentation.ts`).
- Command flags are declared in `cli/src/args.ts`.
- Manifests use YAML and are checked by CLI and API validation (`cli/src/commands/services.ts`; `control-plane/src/manifest/`).
- API routes check authentication/permissions at route boundaries (`control-plane/src/api/services.routes.ts`).
- API input schemas use Zod where structured validation is needed (`control-plane/src/api/`).
- Drizzle schema changes are paired with ordered migrations (`control-plane/src/db/schema.ts`; `control-plane/src/db/migrations/`).
- Agent configuration is JSON and system services vary by OS (`agent/cmd/agent/`).
- The agent reports Docker engine facts, rather than inferring platform from the host runtime.
- Tests use descriptive `node:test` cases (`cli/tests/`; `control-plane/tests/`).
- Existing tests often mock `fetch` at the CLI boundary and exercise API routes against test Postgres.
- Deployment and build failures retain clear terminal states and avoid claiming success from an old release.
- Operational changes use documented Compose commands in `deploy/aws/README.md`.
- Sensitive tokens should not be printed in logs, docs or CLI previews.
- User-owned checkout changes should not be mixed into release commits.
- The CLI package is published from `cli/`; no root npm workspace exists.
- Go formatting/tests are driven by `gofmt` and `go test`.
- This map records current patterns; its contents are not an API contract.
