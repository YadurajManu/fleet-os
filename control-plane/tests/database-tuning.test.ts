import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tunePostgres, tuneRedis } from '../src/databases/tuning.js'

test('Postgres allocations include PgBouncer and bound aggregate pools/concurrent work memory', () => {
  for (const memoryMb of [256, 512, 1024, 4096, 16384]) {
    for (const profile of ['dev', 'standard', 'performance'] as const) {
      const tuned = tunePostgres({ memoryMb, diskMb: 10240, profile, storage: 'ssd' })
      assert.equal(tuned.serverMemoryMb + tuned.poolerMemoryMb, memoryMb)
      assert.ok(tuned.pool.max_db_connections <= tuned.settings.max_connections - 5)
      assert.ok(tuned.pool.default_pool_size * 2 <= tuned.pool.max_db_connections)
      assert.ok(parseInt(tuned.settings.shared_buffers) <= tuned.serverMemoryMb * 0.4)
      assert.ok(parseInt(tuned.settings.work_mem) * tuned.pool.max_db_connections * 4 <= tuned.serverMemoryMb * 1024 * 0.1)
      assert.equal(tuned.settings.password_encryption, 'scram-sha-256')
      assert.equal(tuned.settings.log_parameter_max_length_on_error, 0)
    }
  }
})

test('safe tuning overrides are constrained together and reject executable directives', () => {
  const base = { memoryMb: 512, diskMb: 10240 }
  assert.equal(tunePostgres(base, { shared_buffers: 64, max_connections: 15, work_mem: 128 }).settings.shared_buffers, '64MB')
  for (const overrides of [{ archive_command: 'curl attacker' }, { shared_buffers: '64MB\ninclude=bad' }, { shared_buffers: 512 }, { work_mem: 65536 }, { max_connections: 999 }, { maintenance_work_mem: 512 }]) {
    assert.throws(() => tunePostgres(base, overrides), { code: 'invalid_database_tuning' })
  }
  assert.throws(() => tunePostgres({ memoryMb: 128, diskMb: 1024 }), { code: 'invalid_database_tuning' })
})

test('storage warnings and planner defaults reflect slow or unknown storage', () => {
  assert.equal(tunePostgres({ memoryMb: 1024, diskMb: 10240, storage: 'ssd' }).settings.random_page_cost, 1.1)
  const sd = tunePostgres({ memoryMb: 1024, diskMb: 10240, storage: 'sd' })
  assert.equal(sd.settings.random_page_cost, 4)
  assert.match(sd.warnings.join(), /SD-card/)
  assert.equal(tunePostgres({ memoryMb: 1024, diskMb: 10240 }).settings.random_page_cost, 4)
})

test('Redis modes explicitly trade eviction against durable write refusal and leave memory headroom', () => {
  const input = { memoryMb: 256, diskMb: 1024 }
  const cache = tuneRedis(input, 'cache'), durable = tuneRedis(input, 'durable')
  assert.equal(cache.settings['maxmemory-policy'], 'allkeys-lru')
  assert.equal(cache.settings.appendonly, 'no')
  assert.equal(cache.settings.save, '""')
  assert.equal(durable.settings['maxmemory-policy'], 'noeviction')
  assert.equal(durable.settings.appendonly, 'yes')
  assert.ok(durable.settings.maxmemory < cache.settings.maxmemory)
  assert.match(durable.warnings.join(), /rejects writes/)
  assert.throws(() => tuneRedis(input, 'invented' as never), { code: 'invalid_database_tuning' })
})
