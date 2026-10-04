import React, { useRef, useState } from 'react'
import { geoEqualEarth, geoPath, geoCentroid, geoGraticule10 } from 'd3-geo'
import { feature } from 'topojson-client'
import atlas from 'world-atlas/countries-110m.json'
import countries from 'world-countries'

const byNumeric = new Map(countries.map((country) => [country.ccn3, country]))
const byCode = new Map(countries.map((country) => [country.cca2, country.name.common]))
export const countryName = (code: string) => code === 'unknown' ? 'Unknown location' : byCode.get(code.toUpperCase()) ?? code
const shapes = feature(atlas as unknown as Parameters<typeof feature>[0], (atlas as unknown as { objects: { countries: Parameters<typeof feature>[1] } }).objects.countries)
const features = shapes.type === 'FeatureCollection' ? shapes.features : [shapes]
const projection = geoEqualEarth().fitExtent([[20, 20], [980, 470]], shapes)
const path = geoPath(projection)

export default function OpsMap({ geography, selected, onSelect }: {
  geography: Array<{ country: string; users: number }>; selected: string; onSelect: (country: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const counts = new Map(geography.map((row) => [row.country.toUpperCase(), row.users]))
  const total = geography.reduce((sum, row) => sum + row.users, 0)
  const peak = Math.max(1, ...geography.map((row) => row.users))
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }) }
  return <section className="ops-panel overflow-hidden" aria-label="Account geography">
    <div className="ops-panel-heading"><div><h2>Account geography</h2><p>Country of latest remembered sign-in · approximate</p></div><span className="ops-tag">{total} accounts</span></div>
    <div className="grid lg:grid-cols-[minmax(0,1fr)_250px]">
      <div className="relative min-w-0 overflow-hidden bg-[var(--color-ink-950)]">
        <div className="absolute left-4 top-4 z-10 flex gap-1" aria-label="Map controls">
          <button className="ops-button" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(Math.min(4,zoom + .5))}>+</button>
          <button className="ops-button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => { setZoom(Math.max(1,zoom - .5)); if (zoom <= 1.5) reset() }}>−</button>
          <button className="ops-button" onClick={reset}>Reset</button>
          <span className="ops-muted self-center pl-2">{zoom.toFixed(1)}×</span>
        </div>
        <svg viewBox="0 0 1000 500" className="w-full touch-pan-y" aria-label="Interactive world map; select a country below or drag when zoomed" role="group"
          onPointerDown={(event) => { if (zoom <= 1) return; drag.current={x:event.clientX,y:event.clientY,moved:false}; event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={(event) => {
            if (!drag.current) return
            const scale=1000/event.currentTarget.getBoundingClientRect().width
            const dx=(event.clientX-drag.current.x)*scale,dy=(event.clientY-drag.current.y)*scale
            if (Math.abs(dx)+Math.abs(dy)>2) drag.current.moved=true
            setPan((old) => ({x:Math.max(-1000,Math.min(1000,old.x+dx)),y:Math.max(-500,Math.min(500,old.y+dy))}))
            drag.current.x=event.clientX;drag.current.y=event.clientY
          }} onPointerUp={() => { const current=drag.current; setTimeout(() => { if (drag.current===current) drag.current=null },0) }} onPointerCancel={() => { drag.current=null }}>
          <defs><radialGradient id="ops-ocean"><stop stopColor="var(--color-signal)" stopOpacity=".08"/><stop offset="1" stopColor="var(--color-ink-950)"/></radialGradient></defs>
          <rect width="1000" height="500" fill="url(#ops-ocean)"/>
          <g transform={`translate(${500+pan.x},${250+pan.y}) scale(${zoom}) translate(-500,-250)`}>
            <path d={path(geoGraticule10()) ?? ''} fill="none" stroke="var(--color-line-2)" strokeWidth=".6" opacity=".6"/>
            {features.map((shape,index) => {
              const metadata=byNumeric.get(String(shape.id ?? '').padStart(3,'0'))
              const code=metadata?.cca2 ?? ''
              const count=counts.get(code) ?? 0
              const point=projection(geoCentroid(shape))
              return <g key={`${shape.id}-${index}`}>
                <path d={path(shape) ?? ''} fill={selected===code ? 'var(--color-signal)' : count ? `color-mix(in srgb,var(--color-signal) ${25+Math.round(count/peak*45)}%,var(--color-ink-800))` : 'var(--color-ink-800)'}
                  stroke={selected===code ? 'var(--color-fg)' : 'var(--color-line-2)'} strokeWidth={selected===code ? 1.5 : .7} vectorEffect="non-scaling-stroke"
                  className="cursor-pointer hover:opacity-80" onClick={() => { if (code && !drag.current?.moved) onSelect(code) }}>
                  <title>{metadata?.name.common ?? 'Unmapped territory'} · {count} accounts</title>
                </path>
                {count>0 && point && <circle cx={point[0]} cy={point[1]} r={Math.min(9,3+Math.sqrt(count)) / Math.sqrt(zoom)} fill="var(--color-signal)" stroke="var(--color-ink-950)" strokeWidth="1.5" pointerEvents="none"/>}
              </g>
            })}
          </g>
        </svg>
        <div className="flex flex-wrap justify-between gap-2 px-4 pb-4 ops-muted"><span>Drag to pan after zooming · select a country to inspect accounts</span><span>○ No recorded accounts　● Recorded sign-ins</span></div>
      </div>
      <aside className="border-t border-[var(--color-line)] p-4 lg:border-l lg:border-t-0">
        <p className="ops-eyebrow">{selected ? 'Selected country' : 'Global coverage'}</p>
        <h3 className="mt-2 text-lg font-semibold">{selected ? countryName(selected) : 'All countries'}</h3>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{selected ? counts.get(selected.toUpperCase()) ?? 0 : total}</p><p className="ops-muted">accounts · sign-in location</p>
        {selected && <button className="ops-button mt-3" onClick={() => onSelect('')}>Clear selection</button>}
        <div className="mt-5 max-h-64 space-y-1 overflow-auto" aria-label="Country list">{[...geography].sort((a,b)=>b.users-a.users).map((row)=><button key={row.country} className={`flex w-full justify-between gap-2 rounded px-2 py-2 text-left text-xs ${selected===row.country?'bg-[var(--color-signal)]/10 text-[var(--color-signal)]':'hover:bg-[var(--color-ink-800)]'}`} onClick={()=>onSelect(row.country)}><span>{countryName(row.country)}</span><span className="font-mono">{row.users}</span></button>)}</div>
        <p className="mt-4 ops-muted">VPNs and proxies can affect country accuracy. Nodes have no recorded coordinates; they remain in Infrastructure.</p>
      </aside>
    </div>
  </section>
}
