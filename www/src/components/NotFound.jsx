import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

export default function NotFound({ route }) {
  const [rerouting, setRerouting] = useState(false)
  const timeout = useRef(null)
  const reducedMotion = useReducedMotion()
  const path = `/${route || ''}`.slice(0, 80)

  useEffect(() => () => clearTimeout(timeout.current), [])

  function reroute() {
    if (rerouting) return
    if (reducedMotion) { window.location.assign('/'); return }
    setRerouting(true)
    timeout.current = setTimeout(() => window.location.assign('/'), 700)
  }

  return (
    <section className={`not-found grid-bg${rerouting ? ' is-rerouting' : ''}`} aria-labelledby="not-found-title">
      <div className="rail not-found-layout">
        <div className="not-found-copy">
          <p className="mono-label"><span className="not-found-amber">●</span> REQUEST LOST IN THE MESH · 404</p>
          <h1 id="not-found-title">This route<br /><span>has no node.</span></h1>
          <p className="not-found-lede">This address isn’t attached to anything in the fleet. The rest of the mesh is doing fine.</p>
          <div className="not-found-actions">
            <button type="button" className="not-found-primary focus-inverse" onClick={reroute} disabled={rerouting}>
              {rerouting ? 'Rerouting…' : 'Reroute me home'} <span aria-hidden="true">↗</span>
            </button>
            <a className="not-found-secondary" href="/docs">Browse the docs <span aria-hidden="true">→</span></a>
          </div>
          <p className="not-found-hint">Check the address, or let us reroute you.</p>
        </div>

        <div className="not-found-visual" aria-hidden="true">
          <div className="not-found-visual-top"><span>ROUTE TRACE</span><span>ILLUSTRATION · NOT LIVE TELEMETRY</span></div>
          <svg viewBox="0 0 640 360" role="presentation" focusable="false">
            <path className="not-found-faint" d="M80 184 214 100 374 172 530 86M214 100 260 266 477 285M374 172 477 285" />
            <path className="not-found-active" d="M80 184 214 100 374 172" />
            <path className="not-found-broken" d="M374 172 477 285" />
            <path className="not-found-repaired" d="M374 172 477 285" />
            <circle className="not-found-small-node" cx="80" cy="184" r="7" />
            <circle className="not-found-small-node" cx="214" cy="100" r="5" />
            <circle className="not-found-small-node" cx="260" cy="266" r="5" />
            <circle className="not-found-small-node" cx="530" cy="86" r="5" />
            <circle className="not-found-small-node" cx="374" cy="172" r="9" />
            <circle className="not-found-halo" cx="477" cy="285" r="41" />
            <circle className="not-found-lost-node" cx="477" cy="285" r="24" />
            <text className="not-found-four" x="477" y="291" textAnchor="middle">404</text>
            <text className="not-found-svg-label" x="56" y="215">INGRESS</text>
            <text className="not-found-svg-label" x="335" y="146">LAST HOP</text>
            <text className="not-found-svg-label" x="438" y="341">NO ROUTE</text>
          </svg>
          <div className="not-found-trace"><span>$</span> GET {path} <span className="not-found-trace-result">→ {rerouting ? 'rerouting to /' : 'no route'}</span></div>
        </div>
      </div>
    </section>
  )
}
