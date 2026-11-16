Continue the Fleet Databases build from where you left off (foundations committed on feat/db-v1). Work fully autonomously from here until BOTH V1 and V2 are complete. Do not stop to report, ask, or wait for confirmation.

## Operating mode
- Your last message ended with an increment summary and a remaining-work list. Do not end turns like that. Finishing a milestone means: tests green -> commit -> update notes -> start the next milestone in the same run.
- Stop only when (a) V1 is complete and its PR is open (then branch feat/db-v2 from feat/db-v1 and continue straight into V2), (b) V2 is complete and its PR is open, or (c) a hard blocker leaves nothing else to progress. Even then, finish every unblocked piece of work first.
- Do not ask me questions. Decide, record the decision and rationale in docs/db/BUILD-NOTES.md, and move on. For irreversible or destructive choices, pick the safest option.
- Before starting each milestone, re-read docs/db/REQUEST.md, docs/db/01-design.md and BUILD-NOTES.md so decisions stay consistent across a long run.
- Create and maintain docs/db/PROGRESS.md: every V1 milestone, every V1 and V2 acceptance scenario, its status (not started / in progress / verified), and the exact test or command that proves it. Update it with every commit. This is your resume point if context is lost.
- Push the branch regularly if a remote is configured, so work is not only local.

## Order (API and its matching CLI/UI land together; never leave UI to the end)
1. Finish the engine plugin contract. Build the maintained multi-arch Postgres image (WAL-G, curated extensions), the PgBouncer sidecar and the Redis image, plus the private-registry flow and image pre-pull.
2. Go agent stateful runtime: volume lifecycle, stateful containers, exec and PTY, TCP stream proxying over the tunnel (extend the protocol backward-compatibly, since there is no raw TCP today), disk and storage-type and node-stability reporting, graceful clean DB shutdown. Advertise capabilities only when the handler really works.
3. Database worker that executes operations on the leases you already built (resume after control-plane restart, retries, SSE progress).
4. Scheduler: stateful workload class that is never auto-rescheduled, soft co-location affinity for linked services (keep the existing hard-affinity behavior for existing services untouched), headroom and disk reservation, placement recommendation with stability score and warnings.
5. Lifecycle API + CLI + dashboard UI: create wizard, start/stop/restart, soft delete with grace period and typed confirmation. Use whatever scoping model 01-design.md chose given there is no project table, and match the existing dashboard design system.
6. Roles, links, env injection (pooled vs direct URLs), network isolation for tenant databases without breaking existing services, `db connect` with short-lived scoped tokens, `db shell`, `db exec`.
7. Backup targets, encrypted streamed backups, WAL archiving, PITR, all restore modes, recover, dump, import. Use a MinIO container as the S3-compatible target for real tests. Do not reuse the legacy in-memory volume-tar backup path.
8. Deploy-time migration release phase (Prisma, Drizzle, custom), pre-migration restore points, advisory locking, failure abort, declarative `databases:` config. Legacy manifest databases keep working; give an explicit opt-in transition path, never an automatic conversion.
9. Metrics, slow queries, alerts, tuning visibility.
10. CLI completeness (reuse the existing shared output helpers), full UI completeness, hardening, security pass, Playwright flows, docs, `DOGFOOD-RAUNAK.md` runbook (written, not executed), release prep. Open the V1 PR.
Then V2 in the order given in REQUEST.md, same standards, and open the V2 PR.

## Verification rules
- At every milestone run: full control-plane suite, typecheck, build, `go test ./...`, plus that milestone's real-Docker and end-to-end tests. Do not mark an acceptance scenario verified in PROGRESS.md unless you ran it end to end.
- Label every disposable container, volume and image you create, and remove them when done. Watch Docker Desktop disk usage and prune only your own labeled resources.
- You only have local arm64. For amd64 and Windows, cross-compile and build what you can, and state exactly what was and was not verified. Never claim hardware coverage you do not have.
- New Drizzle migrations (0043 onward) are generated, never hand-edited, and must be safe on a populated database.
- If something is blocked (for example, needs real hardware or external credentials), use a local real substitute where one exists, document the limitation, and keep working on everything else. Never stub or fake it.

## Safety (unchanged)
No production or live servers, no Raunak data, no other directories. Do not merge PRs. Do not publish to npm, the agent release channel or the image registry. Existing agents (v0.2.x), CLI commands, API routes, legacy databases and legacy backups must keep working. Secrets never appear in logs, errors, process args or API responses.

## Reporting
Write the final report (REQUEST.md section 11) only at the end of V1 and again at the end of V2: what was built, what was verified and how, what is incomplete (stated plainly), differences from the prompt, risks and upgrade steps. Between those, only BUILD-NOTES.md and PROGRESS.md carry status. Start now with milestone 1.