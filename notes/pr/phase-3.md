# Phase 3: state transitions, dependency incidents and rollups

Adds three-success recovery hysteresis, two/three-failure escalation, sustained five-minute degradation, maintenance suppression, dependency-linked automatic incidents and fixed public updates. Unknown observations do not contribute to check denominators. Rollups recompute whole retained buckets before raw retention, preserving older daily data.

Rollback: stop prober and revert engine code; preserve all tables and historical data. No production changes.

Validation: notes/status-phase-3-checks.log; control-plane has no lint script.
