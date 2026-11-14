import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const statusComponents = pgTable('status_components', {
  id: text('id').primaryKey(), slug: text('slug').notNull().unique(), name: text('name').notNull(), description: text('description').notNull().default(''),
  group: text('group').notNull(), public: boolean('public').notNull().default(true), sort: integer('sort').notNull().default(0), dependsOn: text('depends_on').array().notNull().default([]),
})
export const statusChecks = pgTable('status_checks', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(), componentId: text('component_id').notNull().references(() => statusComponents.id),
  ts: timestamp('ts', { withTimezone: true }).notNull(), ok: boolean('ok'), latencyMs: real('latency_ms'), statusCode: integer('status_code'), error: text('error'),
  legacySampleId: bigint('legacy_sample_id', { mode: 'number' }).unique(),
  metrics: jsonb('metrics').notNull().default({}),
}, t => [index('status_checks_component_time_idx').on(t.componentId, t.ts)])
export const statusRollups = pgTable('status_rollups', {
  componentId: text('component_id').notNull().references(() => statusComponents.id), bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  granularity: text('granularity').$type<'hour' | 'day'>().notNull(), checks: integer('checks').notNull(), okChecks: integer('ok_checks').notNull(),
  p50: real('p50'), p95: real('p95'), p99: real('p99'), downtimeS: real('downtime_s').notNull().default(0),
}, t => [uniqueIndex('status_rollups_component_bucket_idx').on(t.componentId, t.bucket, t.granularity)])
export const statusIncidents = pgTable('status_incidents', {
  id: uuid('id').primaryKey().defaultRandom(), title: text('title').notNull(), impact: text('impact').notNull(), status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(), resolvedAt: timestamp('resolved_at', { withTimezone: true }), auto: boolean('auto').notNull().default(false),
  legacyEventId: bigint('legacy_event_id', { mode: 'number' }).unique(),
})
export const incidentComponents = pgTable('incident_components', {
  incidentId: uuid('incident_id').notNull().references(() => statusIncidents.id), componentId: text('component_id').notNull().references(() => statusComponents.id),
}, t => [primaryKey({ columns: [t.incidentId, t.componentId] })])
export const incidentUpdates = pgTable('incident_updates', {
  id: uuid('id').primaryKey().defaultRandom(), incidentId: uuid('incident_id').notNull().references(() => statusIncidents.id), status: text('status').notNull(), body: text('body').notNull(), ts: timestamp('ts', { withTimezone: true }).notNull(),
})
export const maintenanceWindows = pgTable('maintenance_windows', {
  id: uuid('id').primaryKey().defaultRandom(), title: text('title').notNull(), startsAt: timestamp('starts_at', { withTimezone: true }).notNull(), endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
})
export const maintenanceComponents = pgTable('maintenance_components', {
  maintenanceId: uuid('maintenance_id').notNull().references(() => maintenanceWindows.id), componentId: text('component_id').notNull().references(() => statusComponents.id),
}, t => [primaryKey({ columns: [t.maintenanceId, t.componentId] })])
export const statusSubscribers = pgTable('status_subscribers', {
  id: uuid('id').primaryKey().defaultRandom(), channel: text('channel').$type<'email' | 'webhook'>().notNull(), target: text('target').notNull(),
  componentIds: text('component_ids').array().notNull().default([]), verifiedAt: timestamp('verified_at', { withTimezone: true }), token: text('token').notNull().unique(),
})
export const statusProberHeartbeat = pgTable('status_prober_heartbeat', { id: text('id').primaryKey(), at: timestamp('at', { withTimezone: true }).notNull() })
export const statusComponentState = pgTable('status_component_state', {
  componentId: text('component_id').primaryKey().references(() => statusComponents.id), status: text('status').notNull().default('unknown'),
  failures: integer('failures').notNull().default(0), successes: integer('successes').notNull().default(0), degradedSince: timestamp('degraded_since', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }), monitoringSince: timestamp('monitoring_since', { withTimezone: true }),
})
export const statusIngestBatches = pgTable('status_ingest_batches', { id: uuid('id').primaryKey(), receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow() })
