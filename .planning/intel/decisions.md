# Extracted decisions

## ADR 0001 — Mesh networking and reaching nodes behind NAT
- source: docs/adr/0001-mesh-and-ingress.md
- status: proposed
- decision: Use an outbound reverse tunnel for public ingress (P1); use tsnet with self-hosted Headscale for future node-to-node networking (P2). The control plane does not join the mesh.
- scope: ingress, NAT, node-to-node networking

The ADR labels P2 as potentially outside v1. Its proposed Headscale decision is not evidence that P2 has shipped.
