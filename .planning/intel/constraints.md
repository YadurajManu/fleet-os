# Extracted technical constraints

## Manifest identity and source
- source: docs/fleet-yaml-spec.md
- type: schema
- content: A root `fleet` and nonempty `services` map define deployment scope. Service names use lowercase letters, digits, and interior hyphens. `defaults` merge beneath individual services. A service uses either `build` or `image`, never both; `repo` identifies a source repository for push deploys.

## Placement contract
- source: docs/fleet-yaml-spec.md
- type: schema
- content: `flexible` permits relocation, `preferred` names an initial node but permits movement, and `pinned` requires a named node and never relocates automatically. A named volume anchors data to its node. Resource memory is both a scheduler constraint and a container memory limit; CPU informs ranking.

## Service connectivity
- source: docs/fleet-yaml-spec.md
- type: protocol
- content: Containers on the same node share a Docker network and resolve service names there. The document explicitly says cross-node service discovery is unavailable until the mesh described by ADR 0001 lands. Dependencies should be co-located with affinity or generated database `uses` placement.

## Secrets
- source: docs/fleet-yaml-spec.md
- type: protocol
- content: Secret names are fleet-scoped with optional service overrides. Values live in the encrypted store, are not written to fleet.yaml or accepted as command arguments, and are resolved into desired state for the target agent. Missing required secrets block a deployment before build.

## Database expansion
- source: docs/fleet-yaml-spec.md
- type: schema
- content: `databases` entries expand into pinned internal services with engine-specific persistent volumes. The first database provides common `DATABASE_*` variables to dependent services. Generated database credentials are created once and retained. The spec names postgres, mysql, mariadb, mongo, and redis engines.

## Backups and restore
- source: docs/fleet-yaml-spec.md
- type: protocol
- content: The agent on the volume's node creates backup archives. Restore requires a stopped service. Scheduled backups use hourly/daily/weekly cadence; failures do not evict good archives. Only one backup per service runs at once, and an unresponsive node eventually fails an in-progress backup.

## Replicas
- source: docs/fleet-yaml-spec.md
- type: protocol
- content: Replicas are reconciled on eligible distinct nodes and reuse the same image. Services with a volume or pinned placement are not scaled. Desired replicas may exceed eligible nodes, in which case the shortfall is reported.

## Health and ingress
- source: docs/fleet-yaml-spec.md
- type: schema
- content: Health probes have path, interval, timeout, and disabled settings. `internal: true` means no public hostname or published port and cannot be combined with `domain`. Volumes are named and default to `/data` unless an explicit path is given.

## Validation
- source: docs/fleet-yaml-spec.md
- type: protocol
- content: A manifest reports all validation errors together, with specific fixes. Warnings identify potentially unsafe but permitted combinations such as flexible services with a volume, multiple replicas sharing one volume, and GPU without an architecture.

## Ingress implementation direction
- source: docs/adr/0001-mesh-and-ingress.md
- type: protocol
- content: The proposed ingress path keeps an outbound agent stream and multiplexes requests through the control plane. Node-to-node tsnet/Headscale is explicitly a later, open-scope decision; do not treat it as a current deployment requirement.
