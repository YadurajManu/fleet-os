# Fleet Operations: company console

Fleet Operations is a separate company console at `ops.<INGRESS_ZONE>`.
Customer `owner` and `admin` roles never grant platform access. Access requires
an authenticated account with verified email, enabled TOTP, and a row in
`platform_operators`. There is deliberately no HTTP grant endpoint. A database
operator must grant and revoke membership out of band; record every grant in
the change log. Do not grant access by email domain or a client-side flag.

## What the first release measures

The 7/30/90-day selector drives signups, new verifications, active organizations
(at least one deployment in the selected period), new fleets, deployments, and
build jobs. Health shows agents with a heartbeat in the last 30 seconds, stale
agents, failed deployments and builds in the last 24 hours. Database size is
read from Postgres. Users can be searched by email; the view shows verification,
organization count, latest sign-in country, and last session time. Nodes show
reported platform, agent version, and heartbeat.

The world map uses Natural Earth country boundaries and the country on a user's
most recent remembered session. It shows country aggregates only. A country is
an approximate sign-in location, not a residence, a precise position, or a live
node location. Users with no country are counted under Unknown. Nodes have no
stored country or coordinates and are shown in a list, not placed on the map.

## Investigation workspace

The sidebar separates Overview, Incidents, Customers, Geography, Infrastructure,
Deployments, Growth, Security, and Releases. Only the active section polls; lists
and timelines are bounded. Customer and deployment searches use 50-row pages.
Detail drawers provide context without leaving the current investigation.

Incidents group stale heartbeats by node and the latest failed deployment by
service. The collector runs every 30 seconds, with a startup grace period equal
to the configured heartbeat interval times the missed-heartbeat threshold.
Acknowledgement, assignment to yourself, notes, resolution, and reopening are
recorded transactionally in a timeline. Resolution and reopening require a note.
Repeated observations do not create duplicate incident events. A cleared signal
resolves an incident; fresh failure evidence can reopen it. Clearing a failure
signal does not prove that an application is healthy. Customer workloads, pins,
secrets, deployments, and node configuration cannot be changed from Ops.

Incident actions require an explicit Bearer token; cookie-only writes are
rejected. Customer reads, deployment reads, and incident action attempts are
recorded in `platform_access_events` without query strings, IPs, or credentials.
Security shows the latest 100 access events and current operator grants. Notes
are plain text and must not contain credentials. Incident and access history is
persistent; automatic history retention/deletion is not enabled in this release.

Optional AI investigation uses the existing configured AI provider. It receives
only incident IDs, statuses, platforms, versions, and timings. Customer source,
emails, IPs, secrets, operator notes, and raw logs are excluded. Responses must
cite supplied evidence IDs, distinguish hypotheses from facts, and disclose
uncertainty. Analysis has a 30-second timeout and an atomic per-operator daily
limit using `AI_DAILY_LIMIT`. No remediation is executed, and analyses are not
stored. Provider handling of submitted evidence follows the configured provider's
policy. When AI is unavailable, recorded evidence remains usable.

## Infrastructure measurements and limits

- API traffic: in-process 15-minute minute buckets for request count, 5xx rate,
  and histogram p95 upper bounds. Health/Ops polling is excluded. Values reset on
  restart and cover one control-plane process, not an entire replicated cluster.
  No traffic and latency beyond the 5-second histogram ceiling show as unknown.
- Postgres: current database size and database connections from server statistics.
- Redis: current used memory and configured memory ceiling; failures are unknown.
- Registry: allocated disk bytes from a read-only registry volume mount, sampled
  at most once per minute with an 8-second timeout. Set `OPS_REGISTRY_STORAGE_PATH`
  for a non-Compose installation. Compose configures it automatically.
- Builds: queued, assigned, and running counts and oldest creation timestamps.
- Nodes: last reported resources, platform, agent version, and heartbeat age.
  Old samples remain visibly stale instead of becoming fresh measurements.

Deployment details show source identity, queue/build duration, image references,
and the previous activated release. They exclude customer source and raw logs.
Releases shows the running revision and agent version counts, with a one-node
rollout checklist. Compatibility requires review; there is no fabricated green
compatibility result or automatic rollout action.

Network transfer/storage and ingress incident telemetry are still unmeasured.
There is no precise user-location tracking or node geolocation. The map uses real
country boundaries, zoom/pan/reset, and keyboard-accessible country filters that
open matching accounts. Unknown locations remain visible. The console is not a
billing source.

## Deployment and access

Migrations `0031_platform_operators` and `0032_operations_incidents` are additive.
Ensure the operator's account
has verified email and TOTP before granting access. From a protected database
session, insert that account's user ID into `platform_operators`; never grant
using a public API. The production Cloudflare tunnel config must add
`ops.<INGRESS_ZONE> -> http://dashboard:80` before the wildcard and create a
proxied DNS record for the hostname. The dashboard serves the same static build
but switches to the isolated Operations UI on the `ops.` host. Its same-origin
`/api` proxy sends requests to server-enforced `/ops/*` routes.

Before rollout, run control-plane and dashboard tests, typechecks, and builds.
Take and verify a Postgres backup outside its container. `deploy/upgrade.sh apply`
records the prior revision and writes an exact rollback script before deploying.
Rollback restores application code and leaves additive incident tables intact.
Never restore the database automatically over new customer writes.

Verify public `/healthz`, the Ops asset and route, anonymous `/api/ops/me` rejection,
and existing customer routes. Sign in with the granted operator account to verify
map filtering and incident workflows against production data. A normal customer
owner must receive 403 for every Ops route. No CLI release is needed for Ops.

Next phases: incident-history retention and export, more signal categories with
explicit thresholds, durable multi-instance metrics, measured network traffic,
and audited approval-based support actions. These require their own design and
tests before exposing workload-changing controls.
