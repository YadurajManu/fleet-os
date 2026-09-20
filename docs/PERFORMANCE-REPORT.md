# Performance report

Local Vite production builds on Node 26.5.0; CI targets Node 24. Decimal kB reported by Vite. No field Core Web Vitals data available.

| Asset | Baseline raw / gzip kB | After first optimization raw / gzip kB |
| --- | --- | --- |
| Main JavaScript | 509.96 / 159.77 | 492.30 / 155.97 |
| Founder, now lazy | bundled | 19.27 / 6.05 |
| Lazy 3D scene | 884.78 / 235.33 | 884.78 / 235.34 |
| CSS | 47.84 / 9.71 | 47.84 / 9.71 |

Baseline build passed. Main bundle decreased by 3.80 kB gzip at this checkpoint; total transferred bytes depend on visited routes and 3D capability. Later status-content edits also remove static incident text. No runtime speed or ranking claim follows from these build numbers.

Changes: lazy founder module; share-card build no longer calls GitHub or writes tracked files; static readable home fallback; existing lazy WebGL, reduced-motion fallback, font display=swap and dimensioned share card retained. Nginx retains long-lived hashed-asset caching and compression, with gzip_vary added.

Remaining: 885 kB 3D chunk triggers Vite warning. Review its value using device/network measurements before a larger redesign. Remote Google Fonts add external requests. Homepage/founder summaries are replaced by React and can shift layout; full component static rendering would need dedicated hydration/animation testing.

Lighthouse, keyboard/mobile visual checks, contrast, LCP, INP and CLS: NOT TESTED. Browser access was rejected by automatic approval review because account usage prevented review from completing. Docker runtime absent, so Nginx compression/cache/HTTP checks: NOT TESTED. Follow up with mobile Lighthouse on production Nginx, keyboard and screen-reader checks, and field metrics after an approved release.
