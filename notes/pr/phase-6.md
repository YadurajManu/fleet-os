# Phase 6: private fleet health API

Adds authenticated /v1/fleet node/service/failover/deployment timing views. Every SQL query is scoped through caller organization membership; foreign detail IDs return 404. Telemetry is read from the existing heartbeat/sample pipeline. Scheduler headroom includes live deployment, build lease and task reservations. Responses are private/no-store.

Optional tunnel_rtt_ms heartbeat field is backward compatible; old agents omit it and responses return null. Unmeasured external reachability, certificate expiry and clone/push/pull/start timing remain null. Resource history is not represented as a complete node uptime history.

Rollback: revert this router and optional heartbeat field; additive status tables remain. No production changes.

Validation: notes/status-phase-6-checks.log, including mandatory cross-tenant and public fixture privacy tests. No control-plane lint script exists.
