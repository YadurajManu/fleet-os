import { useEffect } from 'react'
import { PAGES } from './pages'
import { FOUNDER, metadata, structuredData, serializeJsonLd } from './seo'

export function useDocumentTitle(route) {
  useEffect(() => {
    const page = route === 'founder' ? FOUNDER : Object.hasOwn(PAGES, route) ? PAGES[route] : undefined
    const meta = metadata(route, page, __SITE_ORIGIN__)
    document.title = meta.title
    const set = (attribute, name, content) => {
      let el = document.head.querySelector(`meta[${attribute}="${name}"]`)
      if (!el) { el = document.createElement('meta'); el.setAttribute(attribute, name); document.head.append(el) }
      el.content = content
    }
    set('name', 'description', meta.description)
    set('name', 'robots', meta.indexable ? 'index,follow' : 'noindex,follow')
    for (const [key, value] of Object.entries({ title: meta.title, description: meta.description, url: meta.url, type: meta.type, image: `${__SITE_ORIGIN__}/og.png` })) set('property', `og:${key}`, value)
    for (const [key, value] of Object.entries({ title: meta.title, description: meta.description, image: `${__SITE_ORIGIN__}/og.png` })) set('name', `twitter:${key}`, value)
    let canonical = document.head.querySelector('link[rel="canonical"]')
    if (meta.indexable) {
      if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical) }
      canonical.href = meta.url
    } else canonical?.remove()
    document.head.querySelectorAll('script[type="application/ld+json"]').forEach(el => el.remove())
    structuredData(route, page, __SITE_ORIGIN__, PAGES).forEach(data => {
      const el = document.createElement('script'); el.type = 'application/ld+json'; el.textContent = serializeJsonLd(data); document.head.append(el)
    })
  }, [route])
}
