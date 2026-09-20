# AWS architecture assessment

Repository evidence: deploy/aws/control-plane.yaml defines Lightsail with static IP and snapshots; backups.yaml defines S3 backups and a prefix-scoped IAM writer. Docker Compose runs PostgreSQL, Redis, registry, Fastify control plane, dashboard, marketing Nginx and ingress components. The control plane uses the host Docker socket to build containers. No live AWS resources or credentials were inspected or changed.

## Decision
Keep the existing architecture for this change. The static marketing site does not need a database, Lambda, ECS or a new load balancer. S3 plus CloudFront/ACM is a possible future static-only alternative but requires mapping extensionless page paths and real 404 behavior; it is not provisioned here. Moving the control plane requires separate analysis of Docker socket/build isolation and persistent state.

## Risks and cost drivers
HIGH: SSH CIDR defaults to 0.0.0.0/0 in control-plane.yaml. Operators should explicitly supply a restricted administrative CIDR and review both SSH ports before deployment. HIGH: Docker socket access grants host-level capabilities to the control plane; use a dedicated host and review build isolation. MEDIUM: static IAM backup credentials require protected storage and rotation. Backup policy is scoped to db/* rather than wildcard resources; verify restore credentials separately. Review encryption, restore tests and snapshot retention in the deployed environment.

Unknown traffic/storage assumptions preclude a price estimate. Drivers include VM size, registry image storage/egress, snapshot retention, build cache growth and S3 request/storage volume. Additional CDN infrastructure adds DNS/certificate/cache operations. Existing hosting is the lowest migration-complexity option. Set disk and memory alerts, registry/build-cache budgets, external HTTPS checks and test restores. Do not infer resilience from /healthz alone.

No AWS API, CloudFormation deployment, IAM change, DNS change or cost-bearing resource creation was performed. Infrastructure changes require explicit authorization and credentials.
