import { useEffect, useState } from 'react'
import { APP_URL } from '../lib/data'
import { motion } from 'framer-motion'
import { EASE } from '../lib/motion'
import StatusDot from './ui/StatusDot'
import Logo from './ui/Logo'
import GitHubStarBadge from './ui/GitHubStarBadge'
import MobileMenu, { MenuToggle } from './MobileMenu'

const LANDING_LINKS = [
  ['How it works', '#how'],
  ['Failover', '#failover'],
  ['Compare', '#compare'],
  ['CLI', '#cli'],
  ['Pricing', '#pricing'],
]

// On a sub-page the section anchors are meaningless, so the nav becomes a
// map of the docs instead of a map of the landing page.
const PAGE_LINKS = [
  ['Docs', '/docs'],
  ['CLI', '/docs/cli'],
  ['API', '/docs/api'],
  ['Changelog', '/changelog'],
  ['Pricing', '/#pricing'],
]

export default function Nav({ onPage = false }) {
  const [solid, setSolid] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const links = onPage ? PAGE_LINKS : LANDING_LINKS

  // A route change should never leave the menu hanging open behind the page.
  useEffect(() => {
    const close = () => setMenuOpen(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <motion.header
      initial={{ y: -28, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: EASE.expo, delay: 0.1 }}
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-500 ${
        menuOpen
          ? 'border-[var(--color-line)] bg-[var(--color-ink-950)]'
          : solid
          ? 'border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-950)_82%,transparent)] backdrop-blur-md'
            : 'border-transparent'
      }`}
    >
      <div className="rail flex h-[58px] items-center justify-between">
        <a href="/#top" className="group flex items-center">
          <Logo size={18} word animate />
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="link-draw font-mono text-[11.5px] tracking-[0.02em] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)]"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Community: Discord */}
          <a
            href="https://discord.gg/fleet-os"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Join Fleet OS Discord Community"
            title="Discord Community"
            className="hidden items-center justify-center rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-2 text-[var(--color-fg-muted)] transition-all duration-300 hover:border-[#5865F2] hover:text-[#5865F2] lg:flex"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
          </a>

          {/* Community: GitHub Discussions */}
          <a
            href="https://github.com/YadurajManu/fleet-os/discussions"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Join Fleet OS Discussions on GitHub"
            title="GitHub Discussions"
            className="hidden items-center justify-center rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-2 text-[var(--color-fg-muted)] transition-all duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] lg:flex"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.06l-2.684 2.148A.75.75 0 0 1 3.2 11.6V10h-1.45A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h2.25a.75.75 0 0 1 .75.75v1.272l1.96-1.568a.75.75 0 0 1 .47-.164h3.07a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2.5a.75.75 0 0 1 .75.75v5.5A1.75 1.75 0 0 1 13.5 13.25H12.8v1.6a.75.75 0 0 1-1.22.586L8.85 13.25H7.75a.75.75 0 0 1 0-1.5h1.1a.75.75 0 0 1 .47.164l1.98 1.584V12.5a.75.75 0 0 1 .75-.75h1.45a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 .75-.75Z"/>
            </svg>
          </a>

          {/* Live GitHub Star Counter */}
          <GitHubStarBadge className="hidden sm:inline-flex" />

          <a
            href={APP_URL}
            className="hidden rounded-[3px] border border-[var(--color-line-2)] px-3.5 py-[7px] font-mono text-[11.5px] sm:inline-block text-[var(--color-fg)] transition-all duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
          >
            Get started
          </a>

          <MenuToggle open={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
        </div>
      </div>

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </motion.header>
  )
}
