export const HOME_TITLE = 'Fleet OS — deploy to hardware you already own'
export const HOME_DESCRIPTION = 'Pair your machines, write a fleet.yaml, and git push. Fleet OS builds, places, and runs your services across every device you own — with failover built in.'
export const FOUNDER = {
  title: 'Yaduraj Singh',
  lede: 'Fleet OS is built and maintained by one person. Why it exists, what running it alone can and cannot promise you, and how to get hold of me.',
}
export function siteOrigin(value = 'https://fleet.plastikworld.xyz') {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SITE_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment')
  }
  return url.origin
}
export const serializeJsonLd = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
export function metadata(route, page, origin) {
  return {
    title: route === null ? HOME_TITLE : `${page?.title ?? 'Not found'} — Fleet OS`,
    description: route === null ? HOME_DESCRIPTION : page?.lede ?? 'This page could not be found. Browse the Fleet OS documentation.',
    url: `${origin}/${route ?? ''}`,
    type: route === 'founder' ? 'profile' : route?.startsWith('docs') ? 'article' : 'website',
    indexable: route === null || Boolean(page),
  }
}
export function structuredData(route, page, origin, pages) {
  const meta = metadata(route, page, origin)
  const website = { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Fleet OS', url: `${origin}/` }
  if (route === null) return [{ '@context': 'https://schema.org', ...website }]
  if (!page) return []
  const ancestors = [{ name: 'Fleet OS', item: `${origin}/` }]
  const parent = route.split('/')[0]
  if (route.includes('/') && pages[parent]) ancestors.push({ name: pages[parent].title, item: `${origin}/${parent}` })
  ancestors.push({ name: page.title, item: meta.url })
  return [{
    '@context': 'https://schema.org', '@type': route.startsWith('docs') ? 'TechArticle' : 'WebPage',
    name: page.title, headline: page.title, description: page.lede, url: meta.url,
    inLanguage: 'en', isPartOf: website,
  }, {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: ancestors.map((item, index) => ({ '@type': 'ListItem', position: index + 1, ...item })),
  }]
}
