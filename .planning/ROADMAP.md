# Roadmap

## Current milestone: local snapshot provenance

- [ ] **Phase 1: Inspect and record local deployments** — SNAP-01 through SNAP-06

### Phase 1: Inspect and record local deployments

Goal: Developers can tell exactly what local source a deployment built and compare it with the last successful release.

Success criteria:
1. `fleet changes` shows the local snapshot without uploading anything (SNAP-01).
2. `fleet deploy` and `fleet up` show a preview and upload those same bytes (SNAP-02).
3. The server verifies source identity and excludes failed attempts from the baseline (SNAP-03, SNAP-04).
4. History distinguishes local snapshots from Git commits and retains identity across lifecycle operations (SNAP-05).
5. Additive migration and compatibility checks pass (SNAP-06).

No phase is created for the proposed Headscale mesh; ADR 0001 leaves its v1 scope open.
