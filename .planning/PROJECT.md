# Fleet OS

Fleet OS deploys containerized services to machines the operator owns. This is a brownfield project: the CLI, control plane, dashboard, agent, and website already exist. The codebase map under `codebase/` is the implementation inventory; `intel/` records two existing design documents.

## Current objective

Make local CLI deployments inspectable and attributable. A developer should see the exact included source snapshot before upload, compare it with the last successful release, and recognize the same snapshot in deployment history. This objective comes from the current user request, not from the two ingested documents.

## Constraints

- Preserve the existing `fleet.yaml` contract and authenticated service boundaries. Source: `docs/fleet-yaml-spec.md`.
- A failed deployment must never become the comparison baseline. Source: current user request.
- Do not present Git context as proof of the uploaded bytes. Source: current user request.
- Preserve existing database and deployment compatibility. Source: current user request.

<decisions>
- No ingested architectural decision is locked. ADR 0001 is explicitly proposed.
- The proposed ADR separates reverse-tunnel ingress from a later node-to-node mesh; the latter is not evidence of shipped behavior. Source: `docs/adr/0001-mesh-and-ingress.md`.
</decisions>

## Outside this milestone

Full text diffs, permanent source retention, and the proposed Headscale mesh are outside the local-snapshot feature.
