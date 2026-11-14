const text = { type: 'string' }
const nullableText = { type: ['string','null'] }
const number = { type: ['number','null'] }
const strings = { type: 'array', items: text }
const level = { type: 'string', enum: ['operational','degraded','partial_outage','major_outage','maintenance','unknown'] }
const record = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const list = (items: unknown) => ({ type: 'array', items })
export const tickSchema = record({ start: text, status: level, uptime: number, checks: { type: 'integer' }, p50: number, p95: number, p99: number, incidents: strings })
export const componentSchema = record({ slug: text, name: text, description: text, group: text, status: level, checked_at: nullableText, monitoring_since: nullableText, uptime: number, checks: { type: 'integer' }, ticks: list(tickSchema) })
export const incidentSchema = record({ id: text, title: text, impact: text, status: text, started_at: text, resolved_at: nullableText, components: strings })
export const maintenanceSchema = record({ id: text, title: text, starts_at: text, ends_at: text, components: strings })
export const snapshotSchema = record({ status: level, stale: { type: 'boolean' }, as_of: nullableText, monitoring_since: nullableText, components: list(componentSchema), incidents: list(incidentSchema), maintenance: list(maintenanceSchema) })
export const seriesSchema = record({ ticks: list(tickSchema), monitoring_since: nullableText, coverage: { type: 'number', minimum: 0, maximum: 1 }, uptime: number, checks: { type: 'integer' }, observed_ms: { type: 'number' }, granularity: { type: 'string', enum: ['hour','day'] } })
export const metricsSchema = record({ ...Object.fromEntries(['agents_online_percent','deploys_24h','deploy_success_rate_7d','median_deploy_time_ms','failover_events_30d','median_failover_time_ms'].map(k => [k, number])), agent_version_spread: { anyOf: [{ type: 'null' }, list(record({ version: nullableText, count: { type: 'integer' } }))] }, latest_cli_version: nullableText })
export const incidentListSchema = record({ incidents: list(incidentSchema), next_cursor: nullableText })
export const incidentDetailSchema = record({ ...incidentSchema.properties, updates: list(record({ id: text, status: text, body: text, ts: text })) })
export const maintenanceListSchema = record({ maintenance: list(maintenanceSchema) })
