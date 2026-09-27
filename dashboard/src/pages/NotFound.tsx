import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

export default function NotFound() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [rerouting, setRerouting] = useState(false)
  const timeout = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timeout.current), [])

  function reroute() {
    if (rerouting) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate('/')
      return
    }
    setRerouting(true)
    timeout.current = window.setTimeout(() => navigate('/'), 650)
  }

  return (
    <section className="lost-route grid-bg" aria-labelledby="lost-route-title">
      <div className="lost-route-copy">
        <p className="mono-label"><span className="text-[var(--color-warn)]">●</span> REQUEST LOST IN THE MESH · 404</p>
        <h1 id="lost-route-title">This route<br /><span>has no node.</span></h1>
        <p className="lost-route-lede">This address isn’t attached to anything in the fleet. The rest of the mesh is doing fine.</p>
        <div className="lost-route-actions">
          <button type="button" onClick={reroute} disabled={rerouting} className="lost-route-primary">
            {rerouting ? 'Rerouting…' : 'Reroute me home'} <span aria-hidden="true">↗</span>
          </button>
          <Link to="/services" className="lost-route-secondary">View services <span aria-hidden="true">→</span></Link>
        </div>
        <p className="lost-route-hint">Check the address, or let us reroute you.</p>
      </div>
      <div className={`lost-route-visual${rerouting ? ' is-rerouting' : ''}`} aria-hidden="true">
        <div className="lost-route-visual-top"><span>ROUTE TRACE</span><span>ILLUSTRATION · NOT LIVE TELEMETRY</span></div>
        <svg viewBox="0 0 640 360" role="presentation" focusable="false">
          <path className="lost-route-faint" d="M80 184 214 100 374 172 530 86M214 100 260 266 477 285M374 172 477 285" />
          <path className="lost-route-active" d="M80 184 214 100 374 172" />
          <path className="lost-route-broken" d="M374 172 477 285" />
          <path className="lost-route-repaired" d="M374 172 477 285" />
          <circle className="lost-route-node" cx="80" cy="184" r="7" />
          <circle className="lost-route-node" cx="214" cy="100" r="5" />
          <circle className="lost-route-node" cx="260" cy="266" r="5" />
          <circle className="lost-route-node" cx="530" cy="86" r="5" />
          <circle className="lost-route-node" cx="374" cy="172" r="9" />
          <circle className="lost-route-halo" cx="477" cy="285" r="41" />
          <circle className="lost-route-missing" cx="477" cy="285" r="24" />
          <text className="lost-route-four" x="477" y="291" textAnchor="middle">404</text>
          <text className="lost-route-label" x="56" y="215">INGRESS</text>
          <text className="lost-route-label" x="335" y="146">LAST HOP</text>
          <text className="lost-route-label" x="438" y="341">NO ROUTE</text>
        </svg>
        <div className="lost-route-trace"><span>$</span> GET {pathname.slice(0, 80)} <span>→ {rerouting ? 'rerouting to /' : 'no route'}</span></div>
      </div>
    </section>
  )
}
