# Service domains and URLs

## Delivery in this change

The API, additive migration, ingress lookup, Caddy direct-TLS configuration, dashboard Domains panel, `fleet domains` commands, and public CLI guide are implemented together. The custom-domain check verifies the TXT proof, routing IP, and the certificate presented by the direct ingress; custom names cannot become primary until all three pass. Self-hosted installations must enable the existing `registry-tls` Compose profile, publish ports 80/443, and create DNS records pointing directly to that host. This repository change does not alter DNS or deploy a server.

Redirecting secondary domains to the primary URL, registrar automation, IPv6-only DNS, automatic periodic rechecks, and certificate expiry alerts remain follow-up work. They are not required to route a verified domain and must not be shown as live capabilities.

## Outcome

Every public service has a permanent Fleet-managed URL. An owner or admin can add a memorable Fleet address and one or more domains they control, choose a primary URL, and see exactly whether DNS, ownership, TLS, ingress, and the app are ready. A domain change never redeploys a container or silently breaks the original URL.

## Current behavior and constraints

- Fleet assigns `<service>-<project>-<fleet>-<id>.<INGRESS_ZONE>` and keeps it stable. The one-label shape is required by the managed wildcard certificate and tunnel.
- `fleet.yaml` accepts `domain:`, and ingress has a `services.domain` lookup, but arbitrary customer domains have no ownership verification, DNS guidance, or certificate. The field must not be presented as a working custom-domain feature until the whole path is ready.
- The API and ingress are separate listeners. Caddy already serves direct TLS for the registry and build uploads. Customer-owned domains can use Caddy on-demand TLS with an internal ask endpoint that authorizes **verified** names only.
- The public Fleet URL remains usable if a custom domain's DNS or certificate fails. Internal services never get a public domain.

## Operator experience

### Dashboard

The service detail page gets a **Domains** panel with the permanent Fleet URL, primary URL, domain list, status and actions. The add flow asks for either a Fleet address or a domain the operator owns. For a custom domain, it shows exact TXT proof and A/CNAME target, copy buttons, and a **Check DNS** action. States distinguish `waiting for ownership`, `waiting for routing`, `securing HTTPS`, and `HTTPS verified`; the service health panel reports whether the app itself is serving. A URL is never shown as serving solely because it was saved.

The primary URL can change only after verification and HTTPS readiness. Secondary domains keep serving. Optional 308 redirects are separate future work. Deletion warns when a domain is primary. All controls have keyboard labels, loading feedback, and copy confirmation. Viewers can inspect, not mutate.

### CLI

```
fleet domains [service]                 # names and status
fleet domains add <service> <host>      # claim and print DNS instructions
fleet domains check <service> [host]    # read DNS/TLS/route status
fleet domains primary <service> <host>  # switch once active
fleet domains rm <service> <host>       # remove an alias, never the managed URL
```

`fleet open` and deploy output use the active primary URL; `fleet domains` always shows the permanent Fleet fallback. Interactive output may poll briefly; `--json` emits stable fields and never waits for input. Commands resolve ambiguous service names with `--project`.

### Manifest

`domain:` remains a declaration of a desired custom domain. Apply validates hostname syntax, records its manifest provenance, and returns DNS instructions; it does **not** assert HTTPS readiness. Domains added in the dashboard or CLI are not erased by a later apply that omits `domain:`. A manifest/API conflict is reported rather than silently picking a winner. `internal: true` cannot carry public domains.

## Domain and security model

- Store domains separately from services: normalized lowercase host, globally unique; service ID; `managed_alias` or `custom`; source (`manifest` or `api`); challenge; verification timestamp; primary flag; creation time. Keep legacy `services.domain` as a compatibility read for one release, then migrate reads and remove only in a later compatible release.
- Validate a hostname, not a URL: no scheme, path, port, wildcard, IP literal, Unicode confusable, trailing dot, or empty label. Enforce DNS label lengths. Reserve Fleet's API, dashboard, registry, and all managed Fleet hostnames. An alias under `INGRESS_ZONE` must be a single label and globally available.
- Custom domains require a random DNS TXT token at `_fleet-challenge.<host>`. Claiming a name does not route traffic. Verify the TXT value and then check A/AAAA/CNAME points to the documented direct-TLS ingress. Avoid allowing a user to obtain a certificate for someone else's domain.
- Caddy's on-demand TLS ask endpoint answers 204 only for a verified, still-attached custom host; unknown, removed, internal, or unverified names fail closed. The endpoint is read-only and indexed by hostname. Caddy calls it over the private Compose network; the same API listener can also receive public requests, but its response contains only an allow/deny status. Caddy proxies approved requests to the ingress listener, preserving Host and streaming bodies.
- Ownership challenges are random. Checks are throttled per domain. Domain creation, verification, primary changes, and deletion are audited. Never expose credentials in diagnostics.
- Removing a domain invalidates its ingress cache immediately. Deleting a service removes its domains and permission to renew certificates. A stale certificate alone never grants routing.

## Deployment and operations

- A custom hostname uses an A record to the direct-TLS server (or CNAME to a DNS-only direct-TLS hostname for non-apex names); Cloudflare proxying must be off for this path. Show that tradeoff explicitly because the origin IP becomes public.
- Keep managed Fleet names on the existing Cloudflare tunnel. Do not switch user traffic to direct ingress without their explicit domain setup.
- Persist Caddy's data volume across restarts. Check ACME reachability on ports 80/443 and validate the live certificate before reporting a domain active. Caddy must reject issuance if the control-plane ask endpoint is unavailable.
- Rollout: additive DB migration; deploy the API and ingress before enabling the UI; preserve old agents and existing routes. Rollback disables new domain creation and Caddy catch-all, leaving managed URLs intact.

## Acceptance checks

1. Managed URL continues to return 200 before and after a domain is added, removed, or a deployment fails.
2. Two orgs cannot claim the same name; a malformed, reserved, or unverified name cannot route or obtain a certificate.
3. Dashboard and CLI show the same DNS instructions and states; a viewer cannot mutate them.
4. TXT verification, wrong/missing DNS, delayed DNS, certificate failure, and successful direct HTTPS each produce distinct actionable status.
5. Domain primary switching does not rebuild or move the service. Old aliases continue to serve unless an operator chooses redirect behavior.
6. `fleet apply` never erases API-owned names, and an invalid manifest domain is rejected before database writes.
7. Caddy's ask endpoint rejects unknown and expired/deleted names; no API authentication credential is accepted in place of DNS proof.
8. Existing deployments, managed hostnames, and self-hosted Compose installs pass smoke tests after migration.

## Scope boundaries

No wildcard customer domains, DNS-01 integration with arbitrary registrars, email-domain verification, or automatic edits to customer DNS. Those require separate credentials and support policies. Build-time frontend environment URLs are not rewritten; the UI must warn when a changed API domain may be baked into a frontend and recommend same-origin proxying or redeployment.
