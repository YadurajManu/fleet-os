# Fleet Operations: company console

Fleet Operations is a separate, read-only platform view at `ops.<INGRESS_ZONE>`.
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

Fleet does not yet store time-series API error rates, registry disk utilization,
network storage, or ingress incidents. The console labels those as unmeasured.
Later collectors should define sampling, retention, and failure semantics before
those values become operator signals. The endpoint is not a billing source.

## Deployment and access

Migration `0031_platform_operators` is additive. Ensure the operator's account
has verified email and TOTP before granting access. From a protected database
session, insert that account's user ID into `platform_operators`; never grant
using a public API. The production Cloudflare tunnel config must add
`ops.<INGRESS_ZONE> -> http://dashboard:80` before the wildcard and create a
proxied DNS record for the hostname. The dashboard serves the same static build
but switches to the isolated Operations UI on the `ops.` host. Its same-origin
`/api` proxy sends requests to server-enforced `/ops/*` routes.

Keep this console read-only until a separate design covers support actions,
approval, audit events, and customer-visible boundaries. Its user and node lists
are capped and should be paginated or filtered further before a large rollout.
