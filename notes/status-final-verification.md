# Final verification — 2026-11-14

All services used for verification were local. Production was not contacted or deployed.

| Check | Exact command / context | Result |
| --- | --- | --- |
| Backend compiler/build | control-plane: `npm run typecheck && npm run build` | PASS |
| Backend complete suite after legacy removal | control-plane: `npm test` | PASS, 682 tests; notes/status-final-checks.log |
| Additional fallback regression | control-plane: `npx dotenv -e .env.test -- node --test --import tsx tests/status-fallback.test.ts` | PASS, 1 test |
| Website | www: `npm run build`, `npm test` | PASS, 33 tests; existing bundle-size warning |
| CLI | cli: `npm run typecheck && npm run build && npm test` | PASS, 223 tests |
| Agent | agent: `go test ./...`, repository: `gofmt -d agent/internal/client/client.go` | PASS; no formatting diff |
| Whitespace | `git diff --check` | PASS |
| Lint | No lint scripts configured in these packages | Not available; not represented as a passed linter |
| Fresh database | `DATABASE_URL=postgres://fleetos:test@localhost:55432/fleet_status_fresh_20261114 npx tsx src/db/migrate.ts` | PASS on newly created local database |
| Backfill/current schema | status-migration.test.ts in full suite | PASS: source 3, imported 3, recorded denominator 2, incident 1; replay unchanged |
| Independent ingest | status-ingest.test.ts in full suite | PASS: credential enforcement, duplicate retry, sanitized error |
| State/incident/rollup/API/privacy | status-engine.test.ts, status-system.test.ts | PASS, including real SSE heartbeat at 20 seconds |
| Tenant isolation | status-private.test.ts | PASS: list scoping, foreign detail 404, public fixture privacy |
| Local prober | `PROBE_INTERVAL_S=5 NODE_ENV=test npx dotenv -e .env.test -- npm run fleet-prober` | PASS: two fresh Postgres + two Redis readings and primary heartbeat; stopped |
| HTTP load | `npx dotenv -e .env.test -- tsx scripts/status-load.ts` | PASS: offered 200 rps, 2000 requests, zero failures, p95 11.95ms |
| Browser fixture scenarios | www/tests/status-visual.mjs | PASS: 18 images, keyboard interactions, no overflow/label overlap, clickable footer links |
| Browser real API | www/tests/status-live.mjs | PASS without interception: 14 components, summary/uptime HTTP200, 1440/390 images |
| Graph | `graphify update .` | PASS: refreshed code graph, 3874 nodes / 9861 edges |

See notes/status-api.md for all disabled probes, manual configuration, data limitations and rollback guidance. Static S3/HTTP publication, real email/webhook delivery and dedicated infrastructure canaries require operator infrastructure/credentials and have not been externally verified. Their absence never becomes a fabricated success.

Stacked PRs: phases 1–6 are #28–#33; phase 7 follows them. Merge in phase order, retargeting each subsequent PR after its base merges. No PR was merged automatically.
