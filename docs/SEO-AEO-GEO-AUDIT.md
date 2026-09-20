# SEO, AEO and GEO audit

Audited 2026-09-20 against branch base 575bba8. Existing user edits remain in the original checkout and are excluded.

## Stack and context
Fleet OS is an open-source deployment platform for developers and homelab operators using mixed hardware. The English marketing/documentation site has no verified geographic targeting. Conversion goals are reading setup documentation, visiting the dashboard and contributing. React 19, Vite 8, Tailwind 4 and npm; static HTML generation from page blocks, then React client rendering. Fastify/TypeScript control plane, PostgreSQL/Drizzle, Redis, Go agents and a separate authenticated React dashboard. Docker/Nginx serves marketing; repository deployment documents describe Cloudflare ingress and AWS Lightsail with S3 backups. Live infrastructure was not inspected.

## Findings and prioritized implementation plan
| Severity | Area / evidence | Action |
| --- | --- | --- |
| HIGH | Crawlability: nginx.conf falls back to homepage for unknown routes; router maps unknown paths to home | Real HTTP 404 and client error route |
| HIGH | Homepage: index.html has empty root | Add readable factual HTML and discovery links |
| HIGH | Metadata: prerender duplicates og:type; founder inherits homepage Twitter tags; client hardcodes origin | Shared validated origin, replace metadata consistently |
| MEDIUM | Structured data: legal breadcrumb references missing /legal; JSON is not script-safe | Only existing ancestors, escape script delimiters |
| MEDIUM | Sitemap: build time used as every lastmod | Omit unverified modification dates |
| MEDIUM | AEO: docs have useful direct ledes but some rendered navigation still uses hash links | Path links, retain old inbound hashes |
| MEDIUM | GEO: generator uses fixed telemetry and fallback star counts as social proof | Deterministic factual share card; document content verification backlog |
| MEDIUM | Accessibility: nested main in PageShell; forced smooth TOC scroll | One main landmark; honor reduced motion |
| MEDIUM | Performance: large 3D dependency, third-party fonts; all page components eagerly imported | Measure build; preserve existing lazy 3D and reduced-motion fallback |
| MEDIUM | DevOps: no marketing CI job or artifact validation | Add build and SEO regression checks |
| MEDIUM | Security: no explicit marketing response hardening; inline JSON serialization | Add conservative headers and safe serialization |
| HIGH | AWS: control-plane.yaml defaults SSH CIDR to 0.0.0.0/0 | Document restricted CIDR requirement; no cloud mutation |
| LOW | Docs: www README describes obsolete hash-only routing | Update build/deployment documentation |

## Risks and assumptions
No critical issue established by this source review. Existing content, status/uptime claims, founder biography and competitor comparisons require owner verification; do not manufacture replacements. Static output must agree with React content. The separate API/dashboard need their own authenticated security testing; robots is not access control. No AWS provisioning or deployment authorized. No ranking or citation guarantee. Browser performance, live headers and field Core Web Vitals require measurement, not inference.

## Reference basis
Google JavaScript SEO: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
Google sitemap guidance (lastmod must describe actual significant updates): https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
