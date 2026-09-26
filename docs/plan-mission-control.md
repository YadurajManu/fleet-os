# Mission Control: Fleet and platform administration

**Status:** Fleet Mission Control v1 implemented at `/mission`: fleet-scoped health, placement activity, opt-in coarse node regions, and 60-minute completed-ingress traffic totals. Platform Operations, geographic traffic, alert acknowledgement, and the assistant remain proposals below; they require separate authorization and telemetry work.

## The job

An operator should be able to answer, within a minute: **Is anything broken? Who is affected? What changed? What is the safest next action?** A fleet owner needs this for their own hardware and services. The Fleet OS team needs a separate view of the control plane and all fleets. Those are different trust boundaries, even if the screens share components.

Call the customer view **Mission Control**. Call the internal view **Platform Operations**. Do not turn the existing fleet `admin` role into a global administrator: `control-plane/src/auth/rbac.ts` scopes `viewer`, `deployer`, `admin`, and `owner` to fleet membership today.

## Access: proposed decision

| Surface | Entry | Eligibility | Scope |
| --- | --- | --- | --- |
| Fleet Mission Control | `fleetapp.<zone>/mission` and a **Mission Control** item in the fleet menu | Existing fleet `viewer` or higher | Only the selected fleet |
| Platform Operations | `fleetapp.<zone>/operator`, entered from an **Operator console** item in the account menu | Explicit platform-operator grant, separate from fleet membership | Platform aggregates; individual customer data requires a support-access grant |

Use the existing sign-in/session system. Enforce both gates in the API, not only in React or DNS. A separate `admin.<zone>` hostname could be added later for branding or network policy, but it provides no authorization by itself and creates another DNS/TLS/deployment surface. Prefer the two paths above for the first release.

The account menu should show **Operator console** only to eligible operators. Direct navigation must still return 403 for everyone else. Inside `/operator`, a persistent banner says **Platform Operations** and prevents confusion with a selected customer fleet. Returning to a fleet requires an explicit switch. A fleet owner who is not a platform operator never sees cross-fleet data.

Platform-operator grants should be provisioned out of band by an existing trusted operator or a controlled bootstrap command, never by self-signup or by naming an email address in an environment variable. Require TOTP or an equivalent strong second factor before granting operator access. Support access to one customer fleet should be time-limited, read-only by default, reason-bearing, and recorded in the audit log. It must not expose secret values, password hashes, tokens, or raw build secrets. Emergency mutations need a separate permission and explicit confirmation.

## Screens and useful actions

### 1. Command overview

Top row: healthy services, affected services, online/stale/offline nodes, active builds, pending deployments, public ingress health, and last successful telemetry update. Each number opens the filtered underlying list. An **attention queue** ranks active incidents by customer impact and age, with an owner and acknowledgement state. A **recent changes** strip correlates deployments, rollbacks, node disconnects, agent upgrades, configuration changes, and alerts.

Every live card shows its observation time and source. Missing telemetry is **unknown**, never green or zero. If a customer has no nodes or services, show an onboarding state rather than a fake healthy score.

### 2. Earth view

Three switchable layers: **Nodes**, **Traffic**, and **Incidents**. Nodes are plotted only at an opt-in coarse region; a missing or unreliable location goes in **Unmapped**. Cluster dense points. Clicking a region filters a table below the map; clicking a node opens the existing node detail. The 2D table is the accessible, low-bandwidth fallback and must support every map action.

Traffic arcs must represent measured request flows, not inferred links or animation. The map shows request volume and error rate only after ingress instrumentation exists. Incident halos identify affected regions; they do not expose a customer's exact IP or home location. Users can pause animation and disable motion.

### 3. Reliability and traffic

For each service: request rate, 5xx rate, p50/p95 latency, current deployment, health-check result, restart count, last successful public request, and a timeline of changes. Show traffic and errors together so a zero-error service with zero traffic is not presented as healthy. Time ranges: 1 hour, 24 hours, 7 days. Every chart drills down to the service, deployment, and relevant logs. These follow the latency/traffic/errors/saturation monitoring model rather than a wall of unrelated charts.

### 4. Capacity and placement

Use Docker-effective CPU and memory where available, not host RAM on Docker Desktop. Show headroom, disk reserve, build-cache free space, eligible builders per OCI platform, placement constraints, and services at risk if a node fails. A **What if this node goes offline?** read-only simulation lists services that can move, services with no eligible target, and the reason. A proposed cordon or drain is previewed before execution.

### 5. Builds and deploys

A single job table shows source, platform, builder, queue time, build duration, registry push, image digest, placement, startup, health checks, and outcome. Failure categories link to their evidence. Show **previous release still serving** when true; never infer success from an older running deployment. Operators can retry a failed job or open a rollback preview according to their permissions.

### 6. Incidents and notifications

Group repeated symptoms into one incident with first seen, last seen, affected services/fleets, evidence, acknowledgement, owner, and recovery time. Fleet owners manage their own notification preferences and quiet hours. Platform operators see provider delivery failures and alert backlog in aggregate. A notification saying “sent” must not imply it reached an inbox; show accepted, delivered, bounced, or unknown when the provider supplies that state.

### 7. Security and support operations

Platform Operations shows operator sign-ins, support-access grants, pairing attempts, webhook signature failures, audit events, and rate-limit spikes. Search and export are scoped and audited. The console can identify an affected fleet without opening its secrets. Customer account data is revealed only through the support-access flow.

### 8. Product and growth

Separate tab, not mixed into the incident screen: signups, verified accounts, first paired node, first successful deployment, weekly active fleets, and funnel drop-off. Use aggregate counts with privacy thresholds. This is product analytics, not an operational health signal.

### 9. Evidence-backed assistant

Ask questions such as “Why did API errors rise after 12:40?” The response cites metrics, deployment IDs, event times, and log excerpts within the caller's authorized scope. It distinguishes observation from hypothesis. It may propose a rollback, cordon, or alert change but does not execute one without the usual permission and confirmation. Do not start this feature until the underlying timeline and signals are trustworthy.

## What exists and what must be added

| Signal or control | Current basis | Work before claiming it is live |
| --- | --- | --- |
| Fleet, node, service, deployment, audit and role data | Existing control-plane APIs, database and dashboard | Reuse fleet-scoped endpoints for Mission Control; add aggregate endpoints with operator authorization for Platform Operations |
| CPU, memory, disk and heartbeat | Agent telemetry and node records | Define freshness/unknown states and retention; distinguish Docker-effective capacity from host totals |
| Public request volume, errors and latency | Ingress proxy can observe requests | Add low-cardinality counters/histograms tagged by fleet and service ID; avoid raw URLs, user IPs, and secrets as metric labels |
| Geographic traffic or node regions | No trusted location source established | Opt-in coarse node region; only show traffic regions after privacy-reviewed ingress aggregation |
| Email and webhook delivery | Sender/provider integration and alert events | Store provider message IDs and delivery webhooks or polling results; verify webhook signatures |
| Platform-wide authorization | Fleet-scoped membership and RBAC only | Add separate operator grants, operator API guard, support-access grants, tests and audit records |

Do not add a second telemetry platform by default. Start with the existing Postgres/event data for low-volume status and history. Choose a metrics store only after ingress sampling and retention requirements are measured. Avoid querying one row per customer on every overview request; aggregate server-side and cache short-lived summaries.

## Release slices

1. **Fleet overview (M):** attention queue, freshness, recent changes, drill-downs using existing data. No globe yet. Verify tenant isolation, stale-data display and counts against API records.
2. **Measured traffic (L):** ingress counters and latency, retention, service-scoped charts and alert thresholds. Verify against synthetic requests and expected 2xx/5xx totals.
3. **Earth view (M):** coarse opt-in node regions, accessible table, filters; add traffic and incident layers only when real data exists. Verify no exact location/IP leakage and reduced-motion behavior.
4. **Platform Operations (L):** separate operator grant, aggregate APIs, support-access flow, audit and security review. Verify direct-route/API denial for ordinary fleet owners, cross-tenant isolation, expiry and revocation.
5. **Assistant (L):** grounded read-only investigations, then reviewed actions. Verify citations, permission boundaries and that missing evidence produces “unknown.”

## Decisions to settle together

1. Should Fleet Mission Control replace the current Overview, or launch as an optional second view while we test it? **Recommendation:** make the first release the improved Overview and add `/mission` when the map and incident workflow are ready.
2. Is Platform Operations only for the Fleet OS team, or also for organizations managing many fleets? **Recommendation:** team-only first; an organization portfolio view can later aggregate only that organization's fleets.
3. How should a node's region be set? **Recommendation:** user-selected approximate region, optional and editable; no automatic precise geolocation.
4. Should an operator be able to mutate a customer's fleet? **Recommendation:** no in v1. Time-limited read-only support access first; emergency mutations require a separate, audited design.

## Acceptance bar

- A normal fleet owner cannot fetch another fleet's Mission Control data or any Platform Operations endpoint, even by calling the API directly.
- The overview counts reconcile with the underlying filtered lists, and stale/missing telemetry is visibly distinct from healthy telemetry.
- Every map element corresponds to measured or explicitly configured data, with a table equivalent.
- Every operator action records actor, scope, reason, timestamp and result; support access expires and can be revoked.
- The overview remains useful with the globe disabled and on a narrow screen.
