# Project state

- Milestone: local snapshot provenance
- Phase: 1 complete in commit `599a7f9`; all six CI jobs passed
- Baseline commit at codebase mapping: `186cade`
- Deployed: control plane and public website from `/opt/fleet-os` on 30 September 2026 after the requested 00:10 Asia/Kolkata gate
- Backup: `/home/ubuntu/fleet-backups/fleet-before-599a7f9-20260930.dump`, verified with `pg_restore --list`
- Smoke: API health 200, authenticated CLI identity and node reads, `activated_at` migration present, public website docs 200 from VPS, and `fleet changes backend` previewed local source without upload
- Existing fleet: one node online and three services unplaced before and after; no live app route was available for comparison
- Pending: CLI 0.23.0 remains unpublished to npm
- Source documents: `docs/adr/0001-mesh-and-ingress.md`, `docs/fleet-yaml-spec.md`
- Conflict report: `INGEST-CONFLICTS.md` (zero blockers, warnings, and auto-resolutions)

The original checkout's unrelated edits are not part of this milestone.
