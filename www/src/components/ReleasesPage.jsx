import { useEffect, useId, useRef, useState } from 'react'
import { RELEASE_COMPONENTS, RELEASES, RELEASES_CHECKED_AT } from '../lib/releases'
import './releases.css'

const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeZone:'UTC' }).format(new Date(value)) : 'Publication date not recorded'
const version = value => value ? `${String(value).startsWith('v') ? '' : 'v'}${value}` : 'Not tagged'
const componentName = id => RELEASE_COMPONENTS.find(c => c.id === id)?.name ?? id
function Arrow() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.4" /></svg> }
function Mark({ id }) { return <span className="release-component-mark" aria-hidden="true">{id === 'cli' ? '>_' : id === 'agent' ? '◉' : '⌘'}</span> }
function CommandPanel() {
  const [active,setActive] = useState(RELEASE_COMPONENTS[0]?.id)
  const [copied,setCopied] = useState(false); const [failed,setFailed] = useState(false)
  const code = useRef(null); const timer = useRef(null); const id = useId()
  const component = RELEASE_COMPONENTS.find(c => c.id === active) ?? RELEASE_COMPONENTS[0]
  useEffect(() => () => clearTimeout(timer.current),[])
  async function copy() {
    if (!component?.command) return
    let success = false
    try { await navigator.clipboard.writeText(component.command); success = true } catch {
      const field = document.createElement('textarea'); field.value = component.command; field.setAttribute('readonly',''); field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; document.body.appendChild(field); field.select()
      try { success = document.execCommand('copy') } catch { success = false } finally { field.remove() }
    }
    setCopied(success); setFailed(!success); clearTimeout(timer.current)
    if (!success && code.current) { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(code.current); selection?.removeAllRanges(); selection?.addRange(range); code.current.focus() }
    timer.current = setTimeout(() => { setCopied(false); setFailed(false) },3500)
  }
  function choose(next) { setActive(next); setCopied(false); setFailed(false) }
  if (!component) return null
  return <section className="release-command-panel" aria-labelledby={`${id}-heading`}>
    <div className="release-command-heading"><h2 id={`${id}-heading`}>Ready for an update?</h2><a href="/docs/updates">Read the update guide <Arrow /></a></div>
    <div className="release-command-tabs" role="tablist" aria-label="Update command">{RELEASE_COMPONENTS.map((item,index) => <button type="button" role="tab" key={item.id} id={`${id}-${item.id}-tab`} aria-selected={active === item.id} aria-controls={`${id}-panel`} tabIndex={active === item.id ? 0 : -1} onClick={() => choose(item.id)} onKeyDown={event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? RELEASE_COMPONENTS.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + RELEASE_COMPONENTS.length) % RELEASE_COMPONENTS.length
      choose(RELEASE_COMPONENTS[next].id); document.getElementById(`${id}-${RELEASE_COMPONENTS[next].id}-tab`)?.focus()
    }}>{item.name}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${component.id}-tab`} className="release-command-body"><div className="release-command-line"><span aria-hidden="true" className="release-prompt">$</span><code ref={code} tabIndex={0}>{component.command || 'See the update guide for this component.'}</code><button type="button" className="release-copy" onClick={copy} disabled={!component.command} aria-label={`Copy ${component.name} update command`}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" /><path d="M10 3V2H2v9h1" stroke="currentColor" /></svg>{copied ? 'Copied' : 'Copy'}</button></div><div className="release-command-note"><p>{component.note || 'Review the update guide and release notes before changing a running installation.'}</p><span role="status" aria-live="polite">{copied ? 'Command copied to clipboard.' : failed ? 'Copy blocked. Command selected — press Ctrl+C or ⌘C.' : ''}</span></div></div>
  </section>
}
export default function ReleasesPage() {
  const [filter,setFilter] = useState('all')
  useEffect(() => {
    let frame
    const followAnchor = () => {
      const id = window.location.hash.slice(1)
      if (!RELEASES.some(release => release.id === id) && id !== 'release-history') return
      setFilter('all')
      frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }))
    }
    followAnchor(); window.addEventListener('hashchange',followAnchor)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('hashchange',followAnchor) }
  },[])
  const filters = [{ id:'all', name:'All releases' },...RELEASE_COMPONENTS]
  const releases = filter === 'all' ? RELEASES : RELEASES.filter(release => release.component === filter)
  return <article className="fleet-releases">
    <header className="releases-hero"><nav aria-label="Breadcrumb" className="releases-breadcrumb"><a href="/">fleet·os</a><span aria-hidden="true">/</span><span>Releases</span></nav><div className="releases-eyebrow"><span className="release-dot" aria-hidden="true" />THE RELEASE LOG<span className="release-hero-chip">Fleet OS</span></div><h1>Built to keep<br /><span>moving.</span></h1><div className="releases-hero-bottom"><p>New releases. Clear changes. A steady path forward for the hardware you already own.</p><a className="release-history-jump" href="#release-history">Explore the releases <span aria-hidden="true">↓</span></a></div></header>
    <section className="release-current" aria-labelledby="release-current-title"><div className="release-section-heading"><div><span className="release-label">One fleet. Three moving parts.</span><h2 id="release-current-title">Latest verified versions.</h2></div><span className="release-source-date">Sources checked <time dateTime={RELEASES_CHECKED_AT}>{date(RELEASES_CHECKED_AT)}</time></span></div>
      <div className="release-component-grid">{RELEASE_COMPONENTS.map(component => <article key={component.id} className="release-component-card"><div className="release-component-top"><Mark id={component.id} /><span className="release-channel">{component.channel}</span></div><h3>{component.name}</h3><p className="release-current-version">{version(component.version)}<span className="release-version-dot" aria-hidden="true" /></p>{component.revision && <code className="release-revision">revision {component.revision}</code>}<p className="release-component-summary">{component.summary}</p><div className="release-component-meta"><time dateTime={component.publishedAt || undefined}>{date(component.publishedAt)}</time><a href={component.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${component.name} release source`}>{component.sourceLabel || 'View source'} <Arrow /></a></div></article>)}</div>
    </section>
    <CommandPanel />
    <section className="release-history" id="release-history" aria-labelledby="release-history-heading"><div className="release-section-heading"><div><span className="release-label">What changed</span><h2 id="release-history-heading">The release trail.</h2></div><a href="/changelog" className="release-quiet-link">Product changelog <Arrow /></a></div>
      <div className="release-filter-row"><div className="release-filters" role="group" aria-label="Filter releases">{filters.map(item => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.id === 'all' ? 'All' : item.name}<span aria-hidden="true">{item.id === 'all' ? RELEASES.length : RELEASES.filter(r => r.component === item.id).length}</span></button>)}</div><span className="release-result-count" role="status" aria-live="polite">{releases.length} {releases.length === 1 ? 'release' : 'releases'}</span></div>
      <div className="release-history-list">{releases.length ? releases.map(release => <article className="release-entry" key={release.id} id={release.id}><div className="release-entry-date"><time dateTime={release.publishedAt || undefined}>{date(release.publishedAt)}</time><span className="release-entry-line" aria-hidden="true" /></div><div className="release-entry-content"><div className="release-entry-meta"><span className="release-entry-component">{componentName(release.component)}</span><a className="release-entry-version" href={`#${release.id}`} aria-label={`Permanent link to ${componentName(release.component)} ${version(release.version)}`}>{version(release.version)}<span aria-hidden="true">#</span></a><span className="release-entry-channel">{release.channel}</span></div><h3>{release.title}</h3><p className="release-entry-summary">{release.summary}</p><ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>{release.upgradeNote && <p className="release-upgrade-note"><span className="release-label">Before you update</span>{release.upgradeNote}</p>}<a className="release-source-link" href={release.sourceUrl} target="_blank" rel="noopener noreferrer">{release.sourceLabel || 'Release source'} <Arrow /></a></div></article>) : <div className="release-empty"><h3>No published releases recorded yet.</h3><p>Verified release information for this component will appear here when available.</p></div>}</div>
    </section>
    <aside className="release-upgrade-guidance" aria-labelledby="release-guidance-heading"><div><span className="release-label">Keep it in sync</span><h2 id="release-guidance-heading">A little preparation.<br />A smoother update.</h2><p>Fleet’s CLI, control plane and agents have independent versions. Check your running versions and the release notes before you upgrade.</p><code className="release-check-command"><span aria-hidden="true">$ </span>fleet updates</code></div><ol><li><span>01</span><div><h3>Check your installation</h3><p>Compare the CLI, server revision and agent versions. Read the notes for the versions you are moving between.</p></div></li><li><span>02</span><div><h3>Protect your running fleet</h3><p>Follow the update guide, back up the database, and plan a canary agent update before a wider rollout.</p></div></li><li><span>03</span><div><h3>Confirm the result</h3><p>Check fresh node heartbeats, deployment progress and platform health after the update.</p></div></li></ol><div className="release-guidance-links"><a href="/docs/updates">Update guide <Arrow /></a><a href="/status">Platform status <Arrow /></a><a href="https://github.com/YadurajManu/fleet-os/releases" target="_blank" rel="noopener noreferrer">GitHub releases <Arrow /></a></div></aside>
  </article>
}
