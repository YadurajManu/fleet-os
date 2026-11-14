# Phase 7: public status experience and CLI

Redesigns /status around the site's existing tokens, with one overall banner, Overview/History, accessible component expansion, real measured ticks, four ranges, coverage, incident archive, and neutral unknown/stale states. Adds SSE with polling and an independent snapshot fallback. Footer links remain above the subdued network decoration, duplicate status strip is removed, and low star counts are hidden. Adds anonymous fleet status --public, Status API docs and changelog.

Backend refinements in this phase tighten public serialization, chronological incident cursors and Statuspage severity mapping. The legacy endpoint is removed in a subsequent separate commit after local frontend/API checks.

Validation evidence: notes/status-frontend-checks.log, notes/status-frontend-build.log, notes/status-cli-checks.log, notes/status-visual-checks.log and notes/screenshots/verification.json. 18 screenshots cover 1440/390 widths and nine requested states; fixtures are confined to the browser test harness. Website has no standalone lint/typecheck scripts; Vite and tests verify JS compilation. Existing bundle-size warnings remain.

Migration: use the additive 0039–0041 migrations from preceding phases. Rollback: restore prior frontend and legacy route commit, keep all stored status history. No deployment performed.
