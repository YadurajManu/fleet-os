# Database configuration groundwork

The configuration builders in `control-plane/src/databases/tuning.ts` are implemented and tested. They are not yet connected to an agent runtime, create API, CLI command or dashboard. This document describes their actual behavior; it is not an installation guide for a finished database product.

## Postgres

The allocation includes 64 MiB reserved for a separate PgBouncer process. Minimum total allocation is 256 MiB. Shared buffers default to 25% of the remaining server allocation, with effective cache size at 70%. Backend count scales with memory and is capped at 20/60/100 for dev/standard/performance. Five connections remain outside the pooled budget for administration and maintenance. The pool config includes a database-wide connection cap so separate app/readonly pools cannot each consume the entire budget.

Work memory accounts for pooled connections and several simultaneously active query operators; autovacuum and maintenance receive separate small budgets. These are conservative starting values, not hard upper bounds on total memory: complex queries, direct connections, parallel activity and extensions can consume more. Validate representative workloads before production use. Postgres documents both [shared-buffer sizing and per-operation memory multiplication](https://www.postgresql.org/docs/17/runtime-config-resource.html), and explains that [connection count itself allocates server resources](https://www.postgresql.org/docs/17/runtime-config-connection.html).

Supported numeric overrides:

| Parameter | Input unit and limit |
| --- | --- |
| shared_buffers | MiB; at least 16, at most 40% of server memory |
| work_mem | KiB; at least 64, within the aggregate concurrent-query budget |
| maintenance_work_mem | MiB; at least 1, at most 10% of server memory |
| max_connections | Integer, at least 10, within the memory-derived backend cap |
| random_page_cost | Number from 1 through 10 |
| autovacuum_vacuum_scale_factor | Number from 0.01 through 0.2 |

Unknown/executable directives and string fragments are rejected. SSD planner cost defaults to 1.1; SD/unknown storage uses 4. SD storage emits an explicit checkpoint/wear warning. WAL sizes are budgeted from disk allocation, but `max_wal_size` is a checkpoint target, not a disk quota. This builder does not yet enable WAL archiving or provision a backup target.

Configuration sets SCRAM password encryption and preloads pg_stat_statements. Statement/error-parameter logging is restricted to reduce accidental credential disclosure. The eventual runtime still needs credential-aware redaction for engine output; tuning alone cannot guarantee secrecy.

## Redis

Cache mode has no snapshots/AOF, uses allkeys-lru and caps data memory at 70% of allocation. Durable mode uses AOF/everysec, scheduled RDB settings and noeviction, with 50% reserved for data to leave more room for persistence and allocator overhead. These fractions do not guarantee immunity to OOM during all fork/write workloads. Redis documents [memory outside maxmemory](https://redis.io/docs/latest/reference/eviction/) and the [AOF durability/performance tradeoff](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

Durable mode rejects new writes at the limit; it does not silently evict old keys. Every-second AOF can lose approximately a second on a crash and is not an off-node backup. Both modes require an ACL file at `/etc/fleet/users.acl`; the builder does not create credentials or claim to provide access control by itself.

## Verification

From `control-plane/`:

```sh
node --test --import tsx tests/database-tuning.test.ts
node --test --import tsx tests/database-engines.docker.ts
```

The second command requires Docker and creates separate disposable Postgres 16, Postgres 17 and Redis 7 containers with random localhost ports. It verifies Postgres effective settings, pg_stat_statements and row persistence across restart; Redis authentication, actual eviction/write-refusal behavior and restart persistence/loss. It cleans up its containers, anonymous volumes and temporary credential files. It does not use the control-plane test database as a tenant database. Only local arm64 Docker Desktop has been exercised in this increment; amd64 and Windows still need verification. These tests do not cover maintained images, pooling, backups or Fleet lifecycle flows.
