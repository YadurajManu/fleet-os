# A URL you choose

*A plan for custom domains: setting a service's published hostname from the CLI
and the dashboard, and making it actually serve traffic.*

---

## What already exists

More than I expected, which changes the shape of this work. It is not a feature
to build from nothing; it is a field that exists, is routed correctly, and is
unreachable by any means except editing a file.

**Two names per service.** `services.hostname` is the managed one, generated in
`managedHostname()` (`control-plane/src/ingress/routes.ts:201`) as
`<service>-<fleet>-<6 hex of fleet id>.<INGRESS_ZONE>` — for example
`web-homelab-7efe4c.plastikworld.xyz`. `services.domain`
(`control-plane/src/db/schema.ts:401`) is the custom one, null by default. Both
carry unique indexes.

**The managed name is one label deep on purpose.** `deploy/cloudflare/fleet-os.yml.example`
records why: Cloudflare's free Universal SSL covers the apex and exactly one
level below it, so `web-homelab-7efe4c.zone` has a certificate and
`web.homelab.zone` does not — it fails TLS in the browser with nothing useful in
the error. The flat name is what makes the single `*.ZONE` wildcard tunnel rule
work for every service in every fleet.

**Routing already honours the custom domain.** `resolveRoute()` looks up
`services.hostname` first and falls back to a second query on `services.domain`
(`control-plane/src/ingress/routes.ts:82`). Both resolve to whichever node is
running the service *right now*, so a custom domain survives a failover for the
same reason a managed one does: the routing table is derived, never written.

**The manifest can set it.** `domain:` parses (`manifest/parse.ts:178`), is
checked against `internal:` for contradiction (`parse.ts:250`), and is written
on apply (`manifest/sync.ts:133`).

So the pipe is laid end to end. What is missing is every tap on it.

---

## What is actually missing

**1. There is no way to change it except `fleet.yaml`.** `services.routes.ts`
has twelve routes and not one of them is a PATCH — every mutation goes through
applying a manifest. The dashboard shows the URL
(`dashboard/src/pages/ServiceDetail.tsx:136`) as a link and nothing more.

**2. `domain` is unvalidated.** `z.string().optional()` accepts
`https://shop.example.com/`, `Shop.Example.Com`, `shop.example.com:8080`, and
`not a hostname`. Each is stored, indexed, and silently never matches a `Host`
header. The failure is a service that deploys cleanly and cannot be reached,
with nothing anywhere saying why.

**3. Nothing tells you to point DNS at anything.** Setting `domain:` writes a
row. It does not print a record to create, does not check whether one exists,
and does not notice that the name resolves somewhere else entirely.

**4. Nothing proves you own the domain.** The unique index is the only thing
between a tenant and `domain: google.com`. First writer wins, and on a shared
control plane that is a way to deny a name to whoever legitimately arrives for
it later.

**5. There is no certificate.** This is the hard part and the reason this is a
plan and not a patch. The whole managed-hostname design leans on Cloudflare's
wildcard for `*.ZONE`. A customer's domain is not in that zone, so nothing has
a certificate for it and nothing can get one. **Custom domains do not work
today even when everything above is correct** — the DNS can be right, the route
can resolve, and the browser still refuses the connection.

---

## Stage 0 — decide the shape before writing a migration

`services.domain` is a single nullable column with a unique index: one domain
per service, one service per domain. Verification needs at least a state, a
challenge token and a timestamp, and provenance needs a fourth. That is four
columns bolted to `services` for something that is plainly its own entity — and
retrofitting a table afterwards means migrating live routing.

**Recommendation: a `service_domains` table now** (migration `0022`,
hand-written, since `drizzle-kit generate` is unusable in this repo — its
snapshots stop at 0002).

```
service_domains
  id            uuid pk
  service_id    uuid -> services.id on delete cascade
  host          text unique         -- lowercase, no scheme, no port, no path
  source        text                -- 'manifest' | 'api'
  challenge     text                -- TXT value for _fleet-challenge.<host>
  verified_at   timestamptz null    -- null = declared but not proven
  created_at    timestamptz
```

`services.domain` stays for one release as a read-through view of the primary
row, so the CLI, the dashboard and `resolveRoute` keep working while the writes
move. It buys multiple domains per service (apex plus `www`, a staging name)
without a second migration, and it collapses `resolveRoute`'s two queries into
one join.

---

## Stage 1 — make the field reachable

**Control plane.** `POST /services/:id/domains` and `DELETE /services/:id/domains/:host`,
matching the all-POST idiom of that file rather than introducing a PATCH whose
blast radius is every column on the row.

**The conflict this creates, solved here and not later.** Set a domain from the
dashboard, then `fleet apply` a manifest that does not mention it, and
`sync.ts:133` writes `null` over it. The service goes dark and the apply that
did it reports success. So `source` is load-bearing: **sync only clears domains
it owns** (`source = 'manifest'`). A manifest that declares a domain conflicting
with an API-set one does not silently pick a winner — it lands in the existing
`warnings` array of `SyncResult` and names both.

**CLI.** `fleet domain` as a small command group, usable from any directory the
way `diagnose` and `tune` already are:

```
fleet domain                        # every service and the name it answers to
fleet domain set <service> <host>   # claim it, print the DNS to create, then wait
fleet domain rm <service> <host>
fleet domain check <service>        # what DNS actually says right now
```

When run in a directory holding a `fleet.yaml` that declares the service,
`fleet domain set` should also write `domain:` into the file through
`cli/src/manifest-edit.ts`, which already edits YAML via `parseDocument` and so
preserves comments. The manifest stays the source of truth wherever a manifest
exists; the API path serves the dashboard and the no-repo case.

**Dashboard.** The URL block on `ServiceDetail` becomes editable — the managed
hostname always shown and always working, the custom one added beneath it with
its verification state visible.

---

## Stage 2 — validate, then prove ownership

**Format, rejected at the edge and in the manifest with the same function:**
lowercase; no scheme, port, path or trailing dot; each label 1–63 chars;
a public suffix plus at least one label. Two special rejections worth their own
messages: anything ending in `INGRESS_ZONE` (that is what `hostname` is for, and
allowing it lets one tenant shadow another's managed name), and anything
matching the control plane's own API or dashboard hostnames.

**Ownership by DNS challenge.** `fleet domain set` mints a token and asks for a
`TXT` record at `_fleet-challenge.<host>`. The control plane resolves it —
directly against the authoritative nameservers, not a caching resolver, which
otherwise makes a correct record look absent for up to an hour. `verified_at`
is set on success.

**`resolveRoute` refuses unverified domains.** Not "serves them anyway" — an
unverified name is a claim, and honouring claims is the whole hole in point 4.

**The CLI waits rather than instructing.** `FirstRun` already has the right
shape for this: print the record, then poll and say when it lands. The failure
messages carry what DNS actually returned, because "not verified yet" and
"points at 76.76.21.21, which is not us" are different problems with different
fixes.

---

## Stage 3 — a certificate, which is the real work

Three ways, and they are a genuine fork rather than a ranked list.

**Path A — Cloudflare for SaaS.** Customers `CNAME` to your zone; Cloudflare
terminates TLS for their name at its edge. Keeps DDoS protection, keeps the
origin IP hidden, and the DNS instruction is one record. It is a paid add-on
with per-hostname pricing — **verify the current free allowance and rate before
committing; do not plan against a remembered number.** It also inherits every
edge limit this project has already been bitten by: the 100 MB request body cap
and the ~100 s origin timeout apply to every customer service.

**Path B — Caddy with on-demand TLS.** Caddy is *already in this stack*
(`deploy/caddy/Caddyfile`) terminating ACME TLS for the registry, and for
exactly this class of reason: something that must not go through the tunnel.
On-demand TLS with an `ask` endpoint is almost precisely this feature — Caddy
asks the control plane "may I get a certificate for `shop.example.com`?", the
control plane answers 200 if and only if that host has a `verified_at`, and
Let's Encrypt does the rest. Roughly twenty lines against the table from stage 2.

Free, no vendor coupling, and it **escapes the 100 MB and 100 s limits** —
today every deployed service silently inherits them through the wildcard tunnel,
so a custom domain on Caddy is faster and more capable than the managed name,
not merely prettier. The costs are real: the customer creates an `A` record to
the box, which publishes the origin IP and gives up edge protection, and Let's
Encrypt's rate limits become an operational concern at volume.

**Path C — bring your own certificate.** PEM upload. Not a strategy, but the
escape hatch for an internal CA, and cheap once B exists.

**Recommendation: B, with C as a flag, and A revisited when there are enough
paying tenants for edge protection to be worth its price.** B reuses
infrastructure this repo already runs and already documented the reasoning for.

---

## Stage 4 — the frontend that was built against the old URL

This is the half of the question a domain feature does not answer, and it is
where the surprise lands.

`env:` is runtime only (`manifest/parse.ts:185`). A Vite or Next frontend bakes
`VITE_API_URL` at **build** time. So changing the API's domain updates the API
and leaves the frontend calling the old host — a broken site whose every
individual part reports healthy. Nothing in Fleet currently notices.

Three answers, and the first is the one to lead with:

**1. Same-origin proxying — don't let the frontend know the URL at all.** It is
what Fleet's own dashboard does: its nginx proxies `/api`, so the browser stays
same-origin and never meets CORS. As a manifest field —

```yaml
web:
  build: ./frontend
  proxy: { /api: api }      # 'api' is a service in this fleet
```

— Fleet generates that config, and the API's domain can change forever without
touching the frontend. It also deletes a class of CORS bug that new users hit
constantly.

**2. Runtime config.** Serve `/config.json` at boot instead of baking a
constant. Works anywhere, costs one fetch, needs no Fleet feature.

**3. Build args, and honesty about them.** If `build_args:` lands, then changing
a domain must say what it invalidated:

> `shop.example.com` now serves `api`. 2 services were built against
> `api-homelab-7efe4c.plastikworld.xyz` and will keep calling it until they are
> rebuilt: `web`, `admin`. Run `fleet deploy web admin`.

Fleet knows every build arg it passed and every service that referenced the old
host. Saying so is a lookup, and it is the difference between a feature and a
trap.

---

## Deferred, deliberately

- **Apex domains** (`example.com`, no `www`). A `CNAME` is illegal at an apex;
  it needs ALIAS/flattening, which Cloudflare does and most registrars do not.
  Path B's `A` record sidesteps this entirely — one more argument for it.
- **`www` → apex redirects.** Wanted immediately, but it is a redirect table,
  not a domain feature.
- **Wildcard custom domains** (`*.customer.com`). Needs DNS-01, which needs
  registrar API credentials per tenant.
- **Per-domain access rules.** Real, separate.

---

## Order, and why

1. **Stage 0 + 1** — the table, the routes, `fleet domain`, and the `source`
   rule that stops apply from silently clearing a domain. Independently useful:
   a self-hoster who terminates their own TLS can use custom domains the moment
   this lands.
2. **Stage 2** — validation and DNS verification. Cheap, and it is the
   prerequisite for a certificate rather than a nicety.
3. **Stage 4.1** — `proxy:`, out of order on purpose. It is small, it removes
   the most common way this whole feature goes wrong, and it does not wait on
   TLS.
4. **Stage 3** — Caddy on-demand TLS. The largest piece, and the one that turns
   all of the above from stored intent into a working URL.

---

## Open decisions

- **Path A or B for TLS.** The origin-IP exposure in B is the one thing I would
  not decide alone.
- **Does a fleet get a domain, or only a service?** A fleet-level
  `domain: example.com` with services as `api.example.com`, `web.example.com`
  is a nicer manifest and a much larger routing change.
- **What happens to a verified domain when its service is deleted?** Held
  briefly against re-creation, or released immediately for anyone to claim.
