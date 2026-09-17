import { useEffect, useRef } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { SITE_MAP } from '../lib/nav'
import { EASE } from '../lib/motion'
import { lenisRef } from '../lib/useCapability'
import StatusDot from './ui/StatusDot'
import CopyLine from './ui/CopyLine'
import Logo from './ui/Logo'
import GitHubStarBadge from './ui/GitHubStarBadge'

/* Three rules that morph into a cross. The bars carry the state, so there is
   no second icon to swap in. */
export function MenuToggle({ open, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      aria-controls="mobile-menu"
      aria-label={open ? 'Close menu' : 'Open menu'}
      className="relative -mr-2 flex h-10 w-10 items-center justify-center md:hidden"
    >
      <span className="relative block h-[11px] w-[18px]">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute left-0 block h-[1.5px] w-full bg-[var(--color-fg)]"
            initial={false}
            animate={
              open
                ? [
                    { top: 5, rotate: 45, opacity: 1 },
                    { top: 5, rotate: 0, opacity: 0 },
                    { top: 5, rotate: -45, opacity: 1 },
                  ][i]
                : [
                    { top: 0, rotate: 0, opacity: 1 },
                    { top: 5, rotate: 0, opacity: 1 },
                    { top: 10, rotate: 0, opacity: 1 },
                  ][i]
            }
            transition={{ duration: 0.34, ease: EASE.expo }}
          />
        ))}
      </span>
    </button>
  )
}

export default function MobileMenu({ open, onClose }) {
  const reduce = useReducedMotion()
  const panelRef = useRef(null)

  // Freeze the page underneath, close on Escape, and keep focus inside.
  useEffect(() => {
    if (!open) return
    lenisRef.current?.stop()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') return onClose()
      if (e.key !== 'Tab') return
      const items = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled])'
      )
      if (!items?.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      lenisRef.current?.start()
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id="mobile-menu"
          ref={panelRef}
          initial={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
          animate={{ opacity: 1, clipPath: 'inset(0 0 0% 0)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
          transition={{ duration: 0.48, ease: EASE.expo }}
          className="fixed inset-0 top-[58px] z-40 overflow-y-auto overscroll-contain bg-[var(--color-ink-950)] md:hidden"
        >
          <div className="grid-bg absolute inset-0 opacity-60" />

          <div className="relative rail pb-16 pt-8">
            {/* live strip, so the menu still reads as a control plane */}
            <motion.a
              href="#/status"
              onClick={onClose}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.12, ease: EASE.expo }}
              className="flex items-center gap-2.5 border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3.5 py-2.5"
            >
              <StatusDot size={6} />
              <span className="font-mono text-[11px] text-[var(--color-fg)]">
                All systems operational
              </span>
              <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-dim)]">
                v0.9.2
              </span>
            </motion.a>

            {SITE_MAP.map((col, ci) => (
              <motion.section
                key={col.heading}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.18 + ci * 0.07, ease: EASE.expo }}
                className="mt-9"
              >
                <div className="flex items-center gap-3">
                  <h2 className="mono-label">{col.heading}</h2>
                  <span className="h-px flex-1 bg-[var(--color-line)]" />
                </div>
                <ul className="mt-3">
                  {col.links.map(([label, href]) => (
                    <li key={label + href} className="border-b border-[var(--color-line)] last:border-0">
                      <a
                        href={href}
                        onClick={onClose}
                        className="group flex items-center justify-between py-3 text-[15px] text-[var(--color-fg-muted)] transition-colors duration-300 active:text-[var(--color-fg)]"
                      >
                        {label}
                        <span className="font-mono text-[11px] text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                          →
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </motion.section>
            ))}

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.5, ease: EASE.expo }}
              className="mt-12 border-t border-[var(--color-line)] pt-8"
            >
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <GitHubStarBadge />
                <a
                  href="https://discord.gg/fleet-os"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-[6px] font-mono text-[11.5px] text-[var(--color-fg)] transition-all duration-300 hover:border-[#5865F2] hover:text-[#5865F2]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                  </svg>
                  Discord
                </a>
              </div>
              <CopyLine command="fleet auth login && fleet nodes pair" />
              <a
                href="#pricing"
                onClick={onClose}
                className="focus-inverse mt-4 flex items-center justify-center gap-2 bg-[var(--color-signal)] px-5 py-3.5 text-[14px] font-medium text-[#04140c]"
              >
                Get started
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
              <div className="mt-8 flex items-center justify-between">
                <Logo size={18} word />
                <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
                  © 2026 Fleet OS
                </span>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
