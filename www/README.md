# Fleet OS marketing website

React 19, Vite 8 and Tailwind 4. Node 24 and npm are used in CI and Docker.

```sh
npm ci
npm run dev
npm run build
npm test
npm run preview
```

Build generates 22 public HTML pages, a noindex 404, sitemap.xml, robots.txt and a deterministic 1200×630 share card in dist. No live API is required to generate share cards. Build never modifies tracked public assets. Tests require a completed build. There is no separate lint or TypeScript script for this JavaScript package.

Routes use real paths (/docs/cli); published #/docs/cli links still work. Normal links reload the corresponding static document. PAGES in src/lib/pages.js is the content source, PAGE_ORDER defines sitemap inclusion, and src/lib/seo.js shares metadata and JSON-LD between prerender and React. Documentation blocks are fully prerendered; homepage and founder fallback HTML contain summaries and discovery links, not all interactive content. React replaces the fallback on startup.

## Configuration

VITE_APP_URL is public and defaults to https://fleetapp.plastikworld.xyz. Local development can use http://localhost:8082. Never put credentials in VITE variables. Use .env.example as a template.

SITE_ORIGIN must be supplied in the build process environment so both Vite and prerender see it:

```sh
SITE_ORIGIN=https://fleet.plastikworld.xyz npm run build
SITE_ORIGIN=https://fleet.plastikworld.xyz npm test
```

The default is the existing production origin. Values with paths, credentials, queries or fragments fail the build. Docker accepts SITE_ORIGIN and VITE_APP_URL build arguments. Compose currently supplies APP_URL to VITE_APP_URL; set APP_URL explicitly for production.

## Deployment and rollback

Serve dist with the supplied nginx.conf. It returns real 404 responses, normalizes directory/index aliases, serves canonical extensionless URLs and preserves /healthz. Vite preview is for local inspection and does not validate Nginx's HTTP status/redirect behavior. Do not deploy behind an unconditional SPA fallback. A private preview must be protected by hosting access controls; changing SITE_ORIGIN does not make a preview private.

Before release, run the CI build/test/audit steps and validate Nginx using the built container. Check /, /docs/cli, /docs/cli/, /docs/cli/index.html, /missing, /assets/missing.js, /robots.txt and /sitemap.xml. Verify 200/301/404 as appropriate, security headers and redirects at the public HTTPS edge. Keep the previous image digest and restore it to roll back; verify /healthz and a known documentation page. No deploy-on-push workflow is added.

## Accessibility and performance

The application retains its skip link, focus styles, mobile focus trap, reduced-motion behavior and lazy 3D fallback. PageShell has a single outer main landmark, and its TOC honors reduced motion. Founder code is lazy-loaded. See ../docs/PERFORMANCE-REPORT.md for measurements and remaining browser checks.
