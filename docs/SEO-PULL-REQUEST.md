# SEO, AEO & GEO Website Optimization

Base: main
Head: feature/seo-aeo-geo-optimization

## Summary
Fix inconsistent static/client metadata and soft 404 behavior, improve factual discoverability, and validate generated public pages. Preserve original uncommitted work in a separate checkout.

## Technical SEO
Shared canonical origin and metadata; safe JSON-LD and valid breadcrumb targets; real path links; readable homepage fallback; 22-route sitemap without fabricated dates; noindex dashboard/error pages; Nginx canonical redirects and 404 handling.

## AEO / GEO
Retain structured documentation, add an explicit status explanation, remove unsupported static incident/uptime claims, label example footer telemetry and generate factual share cards. Include search-intent and content plans.

## Performance
Lazy founder module; main bundle reduced from 159.77 to 155.85 kB gzip. Large 3D chunk remains. No Lighthouse or field-CWV claims.

## Security
Compatible fast-uri updates remove the high-severity finding. Four moderate development-tool findings remain. Add safe JSON serialization and conservative Nginx headers; document existing AWS SSH and Docker socket risks.

## Testing
See SEO-IMPLEMENTATION-REPORT.md for every command and actual result: website 27 tests, alternate-origin 27 tests, dashboard 14 tests, selected control-plane 95 tests, Fastify/Ajv URI smoke, builds/typechecks, XML parse and audits pass. Full database integrations, browser/Lighthouse and Nginx runtime checks are NOT TESTED locally and must run before release.

## Files Changed
www metadata, prerender/share-card scripts, routing/navigation, status content, Nginx/Docker configuration and tests; dashboard/index.html; control-plane/package-lock.json; marketing CI; audit, intent, strategy, performance, AWS and implementation documentation.

## Remaining Issues
Browser automatic approval review blocked by account usage; Docker daemon unavailable. Outstanding content verification, moderate tooling advisories, large lazy 3D bundle and reconciliation with pre-existing user edits. No deployment or merge authorized; do not auto-merge.
