---
last_mapped_commit: 186cadee6811e9a641d51e31400c66641b1ee208
last_mapped_at: 2026-09-29
---
# Fleet OS concerns

**Analysis Date:** 2026-09-29

- Local uploads currently retain file names and size but not per-file hashes (`control-plane/src/build/context.ts`; `control-plane/src/db/schema.ts`).
- `cli/src/archive.ts` applies `.dockerignore` exclusions but drops negation rules; snapshot comparison must match this actual packaging behavior.
- `cli/src/commands/services.ts` may display GitHub source for a service that is actually uploading local source.
- Git commit identity is not the same as an included-source snapshot: uncommitted and ignored files alter the build.
- Build contexts are discarded after build; durable metadata must remain small and must not contain source bytes.
- The deploy API receives an uploaded context ID and should verify provenance server-side, not blindly trust client metadata.
- The last attempted deployment may have failed; diff baseline must be the last successful release.
- Large archives are buffered by the current CLI upload path (`cli/src/archive.ts`), with a 256 MiB server cap.
- The control plane is stateful and single-instance; its outage blocks new deployments and can affect ingress (`docs/ARCHITECTURE.md`).
- Docker Desktop storage budget is monitored, not a hard quota, and can overshoot between polls (`docs/ARCHITECTURE.md`).
- Local persistent volumes anchor services to nodes; flexible failover does not move data (`docs/ARCHITECTURE.md`).
- Older agents may not report all new capability fields; migration fields must remain optional (`docs/ARCHITECTURE.md`).
- A published older agent can replace a manually installed newer agent if auto-upgrade is enabled (`docs/ARCHITECTURE.md`).
- Source and build grants are security boundaries; changes need transfer/auth tests (`control-plane/src/build/`).
- Cross-fleet API scoping matters for deployment history and snapshot manifests (`control-plane/src/api/services.routes.ts`).
- Local snapshot file paths can reveal project structure; access must follow existing deployment permissions.
- Uploaded file hashes are metadata, not a substitute for build reproducibility or registry image digests.
- Production rollout must record a prior revision and rollback path (`deploy/aws/README.md`).
- The current Graphify graph is generated; it should be updated after modifying code.
- This map is a starting point for implementation, not a claim that every production path was runtime-tested.
