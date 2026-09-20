import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGES, PAGE_ORDER } from '../src/lib/pages.js'
import { siteOrigin, metadata, structuredData, serializeJsonLd, HOME_DESCRIPTION, FOUNDER } from '../src/lib/seo.js'
const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist')
const origin = siteOrigin(process.env.SITE_ORIGIN)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const href = h => h.startsWith('#/') ? `/${h.slice(2)}` : h.startsWith('#') ? `/${h}` : h
function block(b) {
  switch (b.t) {
    case 'h':
      return `<h2 id="${esc(slug(b.text))}">${esc(b.text)}</h2>`
    case 'p':
      return `<p>${esc(b.text)}</p>`
    case 'list':
      return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    case 'code':
      return `<pre><code>${b.lines.map(esc).join('\n')}</code></pre>`
    case 'kv':
      return `<dl>${b.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    case 'table':
      return (
        `<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
        b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') +
        `</tbody></table>`
      )
    case 'note':
      return `<aside><strong>${b.tone === 'warn' ? 'Careful' : 'Note'}:</strong> ${esc(b.text)}</aside>`
    case 'links':
      // Internal links matter: this is how a crawler discovers the rest.
      return `<ul>${b.items
        .map(([label, h, desc]) => `<li><a href="${esc(href(h))}">${esc(label)}</a> — ${esc(desc)}</li>`)
        .join('')}</ul>`
    case 'status':
      return `<ul>${b.rows.map(([n, s, u]) => `<li>${esc(n)}: ${esc(s)} (${esc(u)})</li>`).join('')}</ul>`
    default:
      return ''
  }
}


const shell = await readFile(join(dist, 'index.html'), 'utf8')
const nav = `<nav aria-label="Site pages"><ul>${['founder', ...PAGE_ORDER].map(route => `<li><a href="/${route}">${esc(route === 'founder' ? FOUNDER.title : PAGES[route].title)}</a></li>`).join('')}</ul></nav>`
function render(route, page, content) {
  const meta = metadata(route, page, origin)
  const head = `<title>${esc(meta.title)}</title>
    <meta name="description" content="${esc(meta.description)}" />
    <meta name="robots" content="${meta.indexable ? 'index,follow' : 'noindex,follow'}" />
    ${meta.indexable ? `<link rel="canonical" href="${esc(meta.url)}" />` : ''}
    <meta property="og:type" content="${meta.type}" />
    <meta property="og:url" content="${esc(meta.url)}" />
    <meta property="og:title" content="${esc(meta.title)}" />
    <meta property="og:description" content="${esc(meta.description)}" />
    <meta property="og:image" content="${esc(origin)}/og.png" />
    <meta name="twitter:title" content="${esc(meta.title)}" />
    <meta name="twitter:description" content="${esc(meta.description)}" />
    <meta name="twitter:image" content="${esc(origin)}/og.png" />
    ${structuredData(route, page, origin, PAGES).map(data => `<script type="application/ld+json">${serializeJsonLd(data)}</script>`).join('\n')}`
  return shell.replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<meta\s+(?:name="(?:description|robots|twitter:(?:title|description|image))"|property="og:(?:type|url|title|description|image)")[^>]*>/g, '')
    .replace(/<link\s+rel="canonical"[^>]*>/g, '')
    .replace('</head>', `${head}</head>`)
    .replace('<div id="root"></div>', `<div id="root"><main id="main" tabindex="-1"><a href="/">Fleet OS</a>${content}${nav}</main></div>`)
}
for (const route of PAGE_ORDER) {
  const page = PAGES[route]
  await mkdir(join(dist, route), { recursive: true })
  await writeFile(join(dist, route, 'index.html'), render(route, page, `<article><h1>${esc(page.title)}</h1><p>${esc(page.lede)}</p>${page.blocks.map(block).join('\n')}</article>`))
}
await mkdir(join(dist, 'founder'), { recursive: true })
await writeFile(join(dist, 'founder/index.html'), render('founder', FOUNDER, `<article><h1>${esc(FOUNDER.title)}</h1><p>${esc(FOUNDER.lede)}</p><a href="https://github.com/YadurajManu">GitHub profile</a></article>`))
await writeFile(join(dist, 'index.html'), render(null, null, `<h1>Deploy to hardware you already own.</h1><p>${esc(HOME_DESCRIPTION)}</p><p>Open source. Self-hosted. Your hardware.</p><a href="/docs">Read the documentation</a>`))
await writeFile(join(dist, '404.html'), render('404', null, '<h1>Page not found</h1><p>Browse the documentation or return to the homepage.</p>'))
const routes = ['', 'founder', ...PAGE_ORDER]
await writeFile(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${esc(`${origin}/${route}`)}</loc></url>`).join('')}</urlset>\n`)
await writeFile(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /healthz\nSitemap: ${origin}/sitemap.xml\n`)
console.log(`Prerendered ${routes.length} public pages and a noindex error page`)
