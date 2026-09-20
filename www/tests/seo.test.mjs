import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { PAGES, PAGE_ORDER } from '../src/lib/pages.js'
import { siteOrigin, serializeJsonLd, metadata, FOUNDER } from '../src/lib/seo.js'
import { currentRoute } from '../src/lib/router.js'
const origin = siteOrigin(process.env.SITE_ORIGIN)
const routes = ['', 'founder', ...PAGE_ORDER]
const read = path => readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8')
const decode = s => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
test('reject malformed canonical configuration', () => {
  for (const value of ['javascript:alert(1)', 'https://u:p@example.org', 'https://example.org/path', 'https://example.org/?x=1', 'https://example.org/#x']) assert.throws(() => siteOrigin(value))
  assert.equal(siteOrigin('https://example.org/'), 'https://example.org')
})
test('JSON-LD escapes HTML script delimiters without changing data', () => {
  const value = { name: '</script><script>alert(1)</script>&' }
  const json = serializeJsonLd(value)
  assert.ok(!json.includes('<'))
  assert.deepEqual(JSON.parse(json), value)
})
test('legacy routes, unknown paths and page anchors remain distinct', () => {
  for (const [pathname, hash, expected] of [['/', '', null], ['/docs/cli', '', 'docs/cli'], ['/unknown', '', 'unknown'], ['/', '#/docs/cli', 'docs/cli'], ['/docs', '#section', 'docs'], ['/', '#/', null]]) {
    globalThis.window = { location: { pathname, hash } }
    assert.equal(currentRoute(), expected)
  }
  delete globalThis.window
})
for (const route of routes) test(`built metadata, content and links: /${route}`, async () => {
  const html = await read(route ? `${route}/index.html` : 'index.html')
  const page = route === 'founder' ? FOUNDER : PAGES[route]
  const expected = metadata(route || null, page, origin)
  assert.equal((html.match(/<title>/g) || []).length, 1)
  assert.equal(decode(html.match(/<title>(.*?)<\/title>/s)[1]), expected.title)
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1)
  assert.equal((html.match(/<main[ >]/g) || []).length, 1)
  assert.ok(html.includes('lang="en"'))
  for (const [attribute, key, value] of [['name','description',expected.description], ['property','og:type',expected.type], ['property','og:title',expected.title], ['property','og:description',expected.description], ['name','twitter:title',expected.title], ['name','twitter:description',expected.description], ['property','og:image',`${origin}/og.png`], ['name','twitter:image',`${origin}/og.png`]]) {
    const matches = [...html.matchAll(new RegExp(`<meta ${attribute}="${key}" content="([^"]*)"`, 'g'))]
    assert.equal(matches.length, 1, key)
    assert.equal(decode(matches[0][1]), value)
  }
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1)
  assert.ok(html.includes(`href="${origin}/${route}"`))
  assert.ok(!html.includes('noindex'))
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]))
  assert.ok(schemas.length)
  for (const schema of schemas) for (const crumb of schema.itemListElement ?? []) assert.ok(routes.includes(new URL(crumb.item).pathname.slice(1)), crumb.item)
  for (const match of html.matchAll(/href="([^"#][^"]*)"/g)) {
    const link = decode(match[1])
    if (!link.startsWith('/') || link.startsWith('//')) continue
    const path = new URL(link, origin).pathname.slice(1)
    if (!routes.includes(path)) await access(new URL(`../dist/${path}`, import.meta.url))
  }
})
test('sitemap and robots expose only canonical public routes', async () => {
  const sitemap = await read('sitemap.xml')
  const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => decode(m[1]))
  assert.deepEqual(locations.sort(), routes.map(r => `${origin}/${r}`).sort())
  assert.ok(!sitemap.includes('<lastmod>'))
  const robots = await read('robots.txt')
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`))
  assert.ok(!/^Disallow: \/$/m.test(robots))
})
test('404 is excluded from indexing and has no canonical', async () => {
  const html = await read('404.html')
  assert.ok(html.includes('noindex,follow'))
  assert.ok(!html.includes('rel="canonical"'))
})
