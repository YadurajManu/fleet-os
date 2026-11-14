# Phase 2: isolated bounded probes

Adds fleet-prober, jittered scheduling, shared legacy dependency checks, sanitized observations, prober heartbeat, HTTP/SSE/TLS/WebSocket and Redis pub/sub probes. Infrastructure canaries are disabled until configured. Build and scheduler canary URLs must perform the actual isolated synthetic workflow; a generic API health URL is not an acceptable substitute.

Rollback: stop fleet-prober and revert this phase; the legacy endpoint and original history continue working. No deployment.

Checks: notes/status-phase-2-checks.log. No lint script exists in the control-plane package; TypeScript and tests are the available checks.
