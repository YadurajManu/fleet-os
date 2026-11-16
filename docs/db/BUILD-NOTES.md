# Fleet Databases build notes

## 2026-11-16 — Discovery and design

- Starting revision: `4c041c1`, branch already `feat/db-v1`. Existing untracked workspace/Graphify/marketing/release files are preserved and excluded from commits.
- Read the repository instructions and queried the existing Graphify graph before focused source inspection. Added `00-understanding.md` and `01-design.md` before feature code.
- Differences: legacy databases expand into services; Redis there has no password; network is fleet-wide; no raw TCP tunnel; volume tar backups buffer in memory and are not engine-consistent PITR; no project table; dashboard already exists; current affinity is hard.
- Decision: retain legacy behavior and introduce separate tenant resources/runtime rather than convert live volumes. No production servers or Raunak data accessed.
- Friction: Docker Desktop was stopped. Started the installed app and verified a local Linux arm64 daemon. No disposable containers created yet.
- Migration risk: SQL history reaches 0041 but Drizzle snapshots stop at 0002. Reconcile metadata on a disposable database before new generated migrations; never rewrite applied SQL.
- Full V1/V2 scope is retained in REQUEST.md. Neither version nor any feature acceptance scenario is complete. No PR, release or registry publication performed.
- Next: foundations (schema, engine contract, durable operations/capabilities), then the matching API/UI in milestone order. All remaining V1 and V2 milestones require implementation and real verification.
