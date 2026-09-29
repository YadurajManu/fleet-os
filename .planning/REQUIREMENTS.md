# Requirements

These active requirements come from the current user request. The two ingested documents contain an ADR and a technical manifest specification, not a PRD. Their contracts are captured under `intel/constraints.md`.

## Local snapshot provenance

- **SNAP-01:** `fleet changes <service>` previews the included local files, ignored rules, upload size, Git context, and source fingerprint without uploading or deploying.
- **SNAP-02:** `fleet deploy` and `fleet up` preview the local snapshot before confirmation and upload the exact archive that was previewed.
- **SNAP-03:** The control plane independently computes the uploaded file fingerprint and per-file hashes; it does not trust client-supplied file hashes.
- **SNAP-04:** Comparisons use the last release that actually reached running state, excluding failed attempts. They report added, modified, and removed file counts when both releases have hashes.
- **SNAP-05:** Deployment history labels a local snapshot separately from a Git commit, shows the target platform and image digest when available, and preserves source provenance through restart and failover.
- **SNAP-06:** Existing agents and deployment records remain compatible; the database migration is additive.

## Verification

- CLI preview makes no upload or deploy request.
- Packing, server extraction, and hashing reflect the same included source.
- A newer failed deployment does not displace a successful baseline.
- CLI typecheck/tests and control-plane typecheck/tests pass in supported CI environments.
