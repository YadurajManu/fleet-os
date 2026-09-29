# Supporting context

## Ingress scope
- source: docs/adr/0001-mesh-and-ingress.md
- note: The ADR separates public ingress behind NAT from cross-node service discovery. It presents reverse tunneling as the near-term ingress solution and leaves the need for a full node mesh in v1 open.

## Manifest examples
- source: docs/fleet-yaml-spec.md
- note: Examples show repository builds, prebuilt images, databases, backups, secrets, replicas, and placement. They are specification examples, not evidence that every described behavior has passed end-to-end verification.
