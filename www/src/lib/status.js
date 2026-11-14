export const STATUS_RANGES = ['24h', '7d', '30d', '90d']
export const statusLabel = status => ({ operational: 'Operational', degraded: 'Degraded performance', partial_outage: 'Partial outage', major_outage: 'Major outage', maintenance: 'Maintenance', unknown: 'Unknown' })[status] ?? 'Unknown'
export const statusColor = status => ({ operational: 'var(--color-signal)', degraded: 'var(--color-warn)', partial_outage: 'var(--color-warn)', major_outage: 'var(--color-down)', maintenance: 'var(--color-fg-muted)', unknown: 'var(--color-fg-muted)' })[status] ?? 'var(--color-fg-muted)'
export const formatUptime = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '—'
export const defaultRange = histories => [...STATUS_RANGES].reverse().find(range => histories[range]?.coverage >= .5) ?? '24h'
export function monthGroups(incidents) {
  const groups = new Map()
  for (const incident of [...incidents].sort((a,b) => Date.parse(b.started_at) - Date.parse(a.started_at))) { const month = String(incident.started_at).slice(0,7); groups.set(month,[...(groups.get(month) ?? []),incident]) }
  return [...groups.entries()]
}
export function staleSnapshot(snapshot, now = Date.now()) {
  return snapshot.stale || !Number.isFinite(Date.parse(snapshot.as_of)) || now - Date.parse(snapshot.as_of) > 60000 ? { ...snapshot, stale: true, status: 'unknown', components: (snapshot.components ?? []).map(c => ({ ...c, status: 'unknown' })) } : snapshot
}
