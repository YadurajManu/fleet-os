# SEO, AEO and GEO implementation report

## Executive summary

Implemented on feature/seo-aeo-geo-optimization in an isolated checkout based on main at 575bba86406e9022417545ac10fa76fbf900bb5c. Original uncommitted CLI and website edits remain untouched in the original checkout; overlapping website changes must be reconciled before combining those edits. No push, deployment, AWS mutation or merge was performed. A local PR description is in SEO-PULL-REQUEST.md.

## Technical SEO

Shared, validated SITE_ORIGIN and page metadata now drive both prerendered HTML and client metadata. Each of 22 public pages has a single canonical, title, description, Open Graph type and appropriate Twitter tags. Founder metadata no longer inherits the homepage card title. JSON-LD escapes script delimiters and breadcrumbs reference only existing parent pages. WebSite, WebPage and TechArticle reflect existing content; no invented ratings, prices or FAQ eligibility.

Generated sitemap includes only public canonical routes and omits unverified lastmod dates. Dashboard HTML explicitly disallows indexing. Unknown routes render a client error page; Nginx configuration returns HTTP 404 rather than the homepage, and normalizes slash/index aliases. Runtime Nginx behavior remains untested locally. robots.txt references the correct sitemap without blocking public pages. Real path navigation replaces internal hash links; legacy inbound hashes remain supported.

## AEO and GEO

Homepage now has a readable no-JavaScript summary and page links. Existing documentation blocks retain their direct answers, headings, lists and examples. Status content explicitly states that static pages do not measure availability; hardcoded uptime percentages and unverified incident history were removed. Footer simulated telemetry is labeled as examples. Share cards contain factual project identity rather than synthetic live metrics. Search-intent map and prioritized content strategy cover every public route and identify verification gaps.

The homepage and founder static HTML are summaries rather than full React component rendering. Other inherited marketing, security, legal, comparison and contact claims still require owner verification. No search ranking or AI citation guarantee is made. Guidance follows Google documentation on [JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) and [sitemap construction](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

## Performance and accessibility

Founder code loads only on its route. Final production build main JavaScript: 492.08 kB raw / 155.85 kB gzip, versus 509.96 / 159.77 at baseline (3.92 kB gzip smaller). Lazy 3D remains 884.78 / 235.34 kB and still triggers Vite's warning. This is a bundle measurement, not a runtime performance result. The share-card build is deterministic and no longer calls GitHub or modifies tracked public files.

Removed nested main from documentation and honored reduced motion for TOC scrolling. Existing skip link, focus handling and lazy WebGL fallback remain. Nginx retains hashed-asset caching and compression. Full keyboard, mobile, screen-reader, contrast and Lighthouse checks are outstanding.

## Security findings

| Severity | Finding / component | Disposition and validation |
| --- | --- | --- |
| HIGH | fast-uri advisories in control-plane lockfile | Updated nested 3.1.5 to 3.1.8 and root 4.1.2 to 4.2.1 within declared ranges; audit now has no high findings; typecheck, build, 95 unit tests and Fastify/Ajv URI smoke passed |
| MODERATE | esbuild through drizzle-kit and deprecated esbuild-kit development tooling | Four audit findings remain; forced suggested downgrade is breaking and was not applied |
| HIGH | AWS SSH CIDR default 0.0.0.0/0 | Documented restricted administrative CIDR recommendation; no infrastructure changed |
| HIGH | Control-plane host Docker socket | Existing host-level trust boundary; documented isolation review, not claimed fixed |
| MEDIUM | Script-unsafe JSON-LD interpolation | Safe serialization; script-closing payload round-trip test passed |
| MEDIUM | Missing marketing security headers | Added nosniff, SAMEORIGIN and referrer policy; HTTP verification outstanding |
| MEDIUM | Secrets / browser configuration | Only public URL values used; changed-file pattern scan found no AWS access-key IDs, private-key blocks or GitHub-token patterns; this is not an exhaustive secret scanner |

Source review observed JWT minimum length validation, production CORS restriction, secure/httpOnly/SameSite cookies and authentication guards. No live penetration test, exhaustive OWASP audit or cross-tenant integration validation was performed. noindex and robots are not access controls.

## DevOps and AWS

Added marketing CI with npm ci, production build, SEO tests, high-severity dependency audit and alternate-origin build/tests. No automatic deployment job. README and .env.example explain public configuration, production APP_URL, Nginx requirements, health checks and image rollback. Existing Lightsail/S3 architecture retained; AWS-ARCHITECTURE.md documents risk, costs without invented prices and simpler alternatives. No cloud credentials used.

## Validation checklist

Commands below ran from the repository root unless a directory is stated.

| Status | Command / check | Actual result |
| --- | --- | --- |
| PASS | npm ci --prefix www | Locked install; no reported vulnerabilities |
| PASS | npm run build --prefix www | Baseline and final production builds; large lazy chunk warning remains |
| PASS | npm test --prefix www | 27/27 pass: 22 page artifacts, metadata, JSON-LD syntax, known links/assets, sitemap/robots, origin rejection, legacy/error routes and 404 indexing |
| PASS | SITE_ORIGIN=https://preview.example.org npm run build --prefix www; same environment npm test --prefix www | Alternate-origin build and 27/27 tests passed |
| PASS | npm audit --prefix www --audit-level=high | Zero vulnerabilities |
| PASS | npm ci --prefix dashboard; npm run typecheck --prefix dashboard; npm test --prefix dashboard; npm run build --prefix dashboard | 14/14 tests; typecheck/build pass. Expected ErrorBoundary test logs a contained error; bundle warning remains |
| PASS | npm audit --prefix dashboard --audit-level=high; npm audit --prefix cli --audit-level=high | Zero vulnerabilities in each |
| PASS | npm ci --prefix control-plane; npm run typecheck --prefix control-plane; npm run build --prefix control-plane | Install, typecheck and build pass |
| PASS | In control-plane: node --test --import tsx tests/buildx.test.ts tests/manifest.test.ts tests/scheduler.test.ts tests/security.test.ts tests/totp.test.ts | 95/95 tests passed |
| PASS | In control-plane: node --input-type=module inline Fastify/Ajv URI smoke | Valid URI query returned 200; invalid query returned 400 |
| PASS | npm audit --prefix control-plane --audit-level=high | High threshold passes; four moderate findings remain |
| PASS | Python xml.etree.ElementTree parse of www/dist/sitemap.xml | Valid XML; 22 URLs |
| PASS | Built dashboard/dist/index.html inspection | noindex,nofollow present |
| PASS | Changed-file secret-pattern scan; git diff --check | No selected secret patterns; no whitespace errors |
| NOT APPLICABLE | www lint / typecheck | No such scripts; JavaScript package; production build and tests used |
| NOT TESTED | Full control-plane npm test / database integrations | Require PostgreSQL, Redis and test configuration; Docker daemon unavailable |
| NOT TESTED | Docker/Nginx config and HTTP redirect/header/error smoke | docker info failed: daemon socket absent |
| NOT TESTED | Browser, Lighthouse, manual accessibility, field CWV | Browser automatic approval review failed because account usage limit prevented review completion |
| NOT TESTED | Live deployment, Search Console, Rich Results Test, external links | No deployment or external validation performed; JSON syntax testing is not rich-result eligibility certification |

Initial SEO regression run failed because the link validator incorrectly classified built CSS as a page. Fixed the validator to check local asset existence, then all tests passed. Initial sandboxed non-website audit calls could not resolve the registry; reruns with network permission succeeded. A path-specific editing command failed before writing; rerun from repository root succeeded. These failures were not treated as passes.

## Remaining recommendations

1. Before release, run browser/keyboard/mobile and Nginx HTTP checks plus the complete database-backed CI suite. Obtain explicit merge approval.
2. Review inherited product/security/legal/contact claims, especially mTLS, WireGuard, KMS, SLA and zero-cost language; verify production APP_URL in Compose.
3. Plan a tested development-tool upgrade for the four moderate findings; restrict SSH and review Docker build isolation in a separately approved infrastructure change.
4. Measure mobile WebGL cost and full static rendering/hydration before larger performance work. Add verified monitoring before publishing availability history.
5. Reconcile this branch with the user's existing website edits before merging them together. Push and remote PR creation remain pending authorization.
