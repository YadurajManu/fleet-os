import { test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { readFile } from 'node:fs/promises'

test('additive status migration preserves checks and events and backfill is repeatable', async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    await sql.begin(async tx => {
      const name = `status_migration_${Date.now()}`
      await tx.unsafe(`CREATE SCHEMA ${name}; SET LOCAL search_path TO ${name},public`)
      await tx.unsafe(await readFile('src/db/migrations/0038_public_status.sql', 'utf8'))
      await tx`insert into public_status_samples(component,status) values ('api','operational'),('api','unknown'),('api','outage')`
      await tx`insert into public_status_events(component,status,message) values ('api','outage','private host must not leak')`
      const migration = await readFile('src/db/migrations/0039_status_system.sql', 'utf8')
      await tx.unsafe(migration)
      await tx.unsafe(migration.split('--> statement-breakpoint')[1]!)
      assert.equal(Number((await tx`select count(*) n from status_checks`)[0]!.n), 3)
      assert.equal(Number((await tx`select count(*) n from public_status_samples`)[0]!.n), 3)
      assert.equal(Number((await tx`select sum(checks) n from status_rollups where granularity='day'`)[0]!.n), 2)
      assert.equal(Number((await tx`select count(*) n from status_incidents`)[0]!.n), 1)
      assert.equal(Number((await tx`select count(*) n from status_components`)[0]!.n), 17)
      await tx.unsafe(`DROP SCHEMA ${name} CASCADE`)
    })
  } finally { await sql.end() }
})
