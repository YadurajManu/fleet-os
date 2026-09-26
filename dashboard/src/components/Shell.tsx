import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { Logo, Dot } from './ui'
import Palette from './Palette'
import { ErrorBoundary } from './ErrorBoundary'

const NAV = [
  { label: 'Overview', to: '/', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
  )},
  { label: 'Nodes', to: '/nodes', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
  )},
  { label: 'Services', to: '/services', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
  )},
  { label: 'Events', to: '/events', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
  )},
  { label: 'Alerts', to: '/alerts', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
  )},
  { label: 'Secrets', to: '/secrets', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m21 2-2 2m-1.5 1.5L10 13l-4 4-2-2-2 2 3 3 7-7 7.5-7.5Z"/><circle cx="15.5" cy="8.5" r="2.5"/></svg>
  )},
  { label: 'Doctor', to: '/doctor', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>
  )},
  { label: 'Logs', to: '/logs', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
  )},
  { label: 'Settings', to: '/settings', icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
  )},
] as const

const PRIMARY = NAV.filter(({ label }) => ['Overview', 'Services', 'Nodes', 'Doctor'].includes(label))
const MORE = NAV.filter(({ label }) => !['Overview', 'Services', 'Nodes', 'Doctor'].includes(label))

export default function Shell() {
  const { email, fleets, fleet, selectFleet, signOut } = useAuth()
  const { pathname } = useLocation()

  // A count in the nav, so a service going down reaches you on whatever page
  // you happen to be on. Four were down for hours and the only way to find
  // out was to open Services and look.
  const services = usePoll(
    () => api<{ services: Service[] }>(`/fleets/${fleet!.id}/services`),
    fleet?.id ? `/fleets/${fleet.id}/services` : null,
    10_000
  )
  const brokenCount = (services.data?.services ?? []).filter(
    (s) => s.current?.status !== 'running' && s.current?.status !== 'online' && s.current?.status !== 'deploying'
  ).length

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-950)_88%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[64px] max-w-[1400px] items-center gap-5 px-6">
          <NavLink to="/" className="shrink-0">
            <Logo size={19} word />
          </NavLink>

          {fleets.length > 0 && (
            <label className="relative">
              <span className="sr-only">Fleet</span>
              <select
                value={fleet?.id ?? ''}
                onChange={(e) => selectFleet(e.target.value)}
                className="cursor-pointer appearance-none rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] py-1.5 pl-3 pr-8 font-mono text-[11.5px] text-[var(--color-fg-muted)] outline-none transition-colors hover:border-[var(--color-line-2)]"
              >
                {fleets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[9px] text-[var(--color-fg-dim)]">▾</span>
            </label>
          )}

          <nav aria-label="Primary navigation" className="ml-1 hidden items-center gap-1 md:flex">
            {PRIMARY.map(({ label, to, icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `relative flex items-center gap-1.5 rounded-[3px] px-3 py-2 font-mono text-[12px] transition-colors duration-200 ${
                    isActive
                      ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)] font-medium after:absolute after:bottom-0 after:left-3 after:right-3 after:h-[2px] after:bg-[var(--color-signal)]'
                      : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)] hover:bg-[var(--color-ink-900)]'
                  }`
                }
              >
                <span className="opacity-75">{icon}</span>
                <span>{label}</span>
                {label === 'Services' && brokenCount > 0 && (
                  <span
                    title={`${brokenCount} service${brokenCount === 1 ? '' : 's'} not running`}
                    className="ml-1 inline-flex min-w-[15px] items-center justify-center rounded-full bg-[var(--color-down)] px-1 text-[9px] font-semibold text-[var(--color-ink-950)]"
                  >
                    {brokenCount}
                  </span>
                )}
              </NavLink>
            ))}
            <details key={pathname} className="group relative">
              <summary className="cursor-pointer list-none rounded-[3px] px-3 py-2 font-mono text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-ink-900)] hover:text-[var(--color-fg)]">More ▾</summary>
              <div className="absolute left-0 top-full z-50 mt-2 min-w-44 border border-[var(--color-line)] bg-[var(--color-ink-900)] p-1 shadow-xl">
                {MORE.map(({ label, to }) => <NavLink key={to} to={to} className="block rounded px-3 py-2 font-mono text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-fg)]">{label}</NavLink>)}
                {(fleet?.role === 'owner' || fleet?.role === 'admin') && <NavLink to="/audit" className="block rounded px-3 py-2 font-mono text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-fg)]">Audit history</NavLink>}
              </div>
            </details>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('fleet:open-palette'))} aria-label="Search" className="font-mono text-[15px] text-[var(--color-fg-muted)] sm:hidden">⌕</button>
            {/* Quick Command Palette Trigger Button */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('fleet:open-palette'))}
              title="Open command palette (⌘K)"
              className="hidden sm:flex items-center gap-2 rounded border border-[var(--color-line)] bg-[var(--color-ink-900)] px-2.5 py-1 text-[11px] font-mono text-[var(--color-fg-muted)] hover:border-[var(--color-line-2)] hover:text-[var(--color-fg)] transition-all"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--color-fg-dim)]"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <span className="hidden lg:inline text-[10.5px]">Search anything</span>
              <kbd className="rounded bg-[var(--color-ink-800)] border border-[var(--color-line-2)] px-1 py-0.2 text-[9px] text-[var(--color-fg-dim)] font-semibold">⌘K</kbd>
            </button>

            <NavLink to="/services" className="hidden rounded-[3px] bg-[var(--color-signal)] px-3 py-2 font-mono text-[11px] font-medium text-[var(--color-ink-950)] hover:opacity-90 lg:block">+ Deploy</NavLink>
            {brokenCount > 0 && <NavLink to="/services" title={`${brokenCount} services need attention`} className="rounded-full bg-[var(--color-down)] px-2 py-1 font-mono text-[10px] text-[var(--color-ink-950)]">{brokenCount}</NavLink>}
            <details key={pathname} className="relative">
              <summary aria-label="Account menu" className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full border border-[var(--color-line-2)] bg-[var(--color-ink-800)] font-mono text-[11px] text-[var(--color-fg)]">{email?.slice(0, 2).toUpperCase()}</summary>
              <div className="absolute right-0 top-full z-50 mt-2 min-w-56 border border-[var(--color-line)] bg-[var(--color-ink-900)] p-2 shadow-xl">
                <p className="break-all px-2 py-2 text-[11px] text-[var(--color-fg-muted)]">{email}</p>
                {fleet && <p className="px-2 pb-2 font-mono text-[10px] text-[var(--color-fg-dim)]"><Dot size={5} /> {fleet.role} · {fleet.name}</p>}
                <NavLink to="/settings" className="block rounded px-2 py-2 text-[12px] hover:bg-[var(--color-ink-800)]">Settings</NavLink>
                <button onClick={signOut} className="w-full rounded px-2 py-2 text-left text-[12px] hover:bg-[var(--color-ink-800)]">Sign out</button>
              </div>
            </details>
          </div>
        </div>

        <details key={pathname} className="border-t border-[var(--color-line)] md:hidden">
          <summary className="cursor-pointer px-6 py-2.5 font-mono text-[12px] text-[var(--color-fg-muted)]">Menu · {NAV.find(({ to }) => to === pathname)?.label ?? 'Fleet'} ▾</summary>
          <nav aria-label="Mobile navigation" className="grid grid-cols-2 gap-1 border-t border-[var(--color-line)] p-3">
          {NAV.map(({ label, to, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `shrink-0 flex items-center gap-1.5 rounded-[3px] px-2.5 py-1.5 font-mono text-[11px] ${
                  isActive ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)] font-medium border-b border-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'
                }`
              }
            >
              <span className="opacity-75">{icon}</span>
              <span>{label}</span>
              {label === 'Services' && brokenCount > 0 && (
                <span className="ml-1 inline-flex min-w-[15px] items-center justify-center rounded-full bg-[var(--color-down)] px-1 text-[9px] font-semibold text-[var(--color-ink-950)]">
                  {brokenCount}
                </span>
              )}
            </NavLink>
          ))}
          {(fleet?.role === 'owner' || fleet?.role === 'admin') && <NavLink to="/audit" className="rounded p-2 font-mono text-[11px] text-[var(--color-fg-muted)]">Audit history</NavLink>}
          </nav>
        </details>
      </header>

      {/* Mounted once, at the shell, so it is reachable from every page. */}
      <Palette />

      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
