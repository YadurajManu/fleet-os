# CLI output captures

Representative terminal output from the fixture data used by the CLI output
tests. Colors are shown by their status glyphs; commands are the cyan/action
items in an interactive terminal. No production API was called for these
captures.

## `fleet status`

```text
fleet ▸ homelab  ▲ DEGRADED
1 node online · 1 of 3 services running · 2 failed

NODES
NODE          PLATFORM     ROLE     LOAD            MEMORY       RUNS       STATUS
● pi-builder  linux/arm64  builder  ██░░░░░░ 21%  2.8 / 4.0GB  db, cache  ● online

SERVICES
SERVICE     NODE        STATUS     LAST DEPLOY  FAILURES (7D)
db          pi-builder  ● running  0s ago       0
web         pi-builder  ✖ failed   0s ago       2
wa-gateway  pi-builder  ✖ failed   0s ago       2

PROBLEMS
✖ web, wa-gateway  build disk monitor timed out
  → fleet logs web --follow
  → fleet logs wa-gateway --follow

updated 0s ago · --watch for live view · --json for scripts
```

## `fleet nodes ls`

```text
NODE                 PLATFORM     ROLE     LOAD        MEMORY       RUNS       SEEN     STATUS
● pi-builder         linux/arm64  builder  ██░░░░ 21%  2.8 / 4.0GB  db, cache  0s ago   ● online
▲ storage-node       linux/amd64  standard —           —            db         2m ago   ▲ cordoned
```

## `fleet services`

```text
homelab  2/3 running · 1.2GB
SERVICE  URL                      PLACEMENT  NODE        SHA      STATUS
db       —                        pinned     pi-builder  a17bc21  ● running
web      web.fleet.local          balanced   pi-builder  c942e10  ✖ failed
```

## `fleet events`

```text
RECENT EVENTS
TIME    SUBJECT       EVENT             DETAILS
0s ago  › db          placed            — → pi-builder · score 0.927
1m ago  ▲ web         failover          pi-builder → storage-node · score 0.812
```

## `fleet deploy web`

```text
✔ choosing a node — placed on pi-builder
✔ building the image — image built
✔ pushing to the fleet registry — image pushed
✔ scheduling onto the node — pi-builder
◌ waiting for the container — health check pending
✔ web deployed
View logs: fleet logs web
```

The deploy ladder is already shared by `deploy` and `up`; its TTY redraw and
plain transcript behavior remain unchanged.
