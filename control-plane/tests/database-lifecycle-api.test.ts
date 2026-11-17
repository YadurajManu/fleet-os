import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { orgs, users } from '../src/db/schema.js'
import type { FastifyInstance } from 'fastify'

let ctx: AppContext
let app: FastifyInstance
let account: {
  user: { id: string }
  org: { id: string }
  fleet: { id: string }
  accessToken: string
}

before(async () => {
  ctx = createContext(loadConfig())
  app = await buildServer(ctx)
  const response = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email: `database-lifecycle-${randomUUID()}@example.test`,
      password: 'database-lifecycle-test-passphrase',
    },
  })
  assert.equal(response.statusCode, 201, response.body)
  account = response.json()
})

after(async () => {
  await app.close()
  await ctx.db.delete(orgs).where(eq(orgs.id, account.org.id))
  await ctx.db.delete(users).where(eq(users.id, account.user.id))
  await closeContext(ctx)
})

const url = (suffix: string) =>
  `/fleets/${account.fleet.id}/projects/api-test/databases${suffix}`
const headers = () => ({ authorization: `Bearer ${account.accessToken}` })

test('catalog is authenticated and create requires an idempotency key', async () => {
  const unauthorized = await app.inject({ url: url('/catalog') })
  assert.equal(unauthorized.statusCode, 401)

  const catalog = await app.inject({
    url: url('/catalog'),
    headers: headers(),
  })
  assert.equal(catalog.statusCode, 200, catalog.body)
  assert.ok(
    catalog
      .json()
      .engines.some(
        (engine: { engine: string }) => engine.engine === 'postgres',
      ),
  )
  assert.ok(
    catalog
      .json()
      .engines.some((engine: { engine: string }) => engine.engine === 'redis'),
  )

  const missingKey = await app.inject({
    method: 'POST',
    url: url(''),
    headers: headers(),
    payload: { name: 'primary', engine: 'postgres' },
  })
  assert.equal(missingKey.statusCode, 400)
  assert.equal(missingKey.json().error.code, 'invalid_idempotency_key')
})

test('create without an eligible data node leaves no database allocation', async () => {
  const response = await app.inject({
    method: 'POST',
    url: url(''),
    headers: { ...headers(), 'idempotency-key': randomUUID() },
    payload: { name: 'primary', engine: 'postgres' },
  })
  assert.equal(response.statusCode, 422, response.body)
  assert.equal(response.json().error.code, 'database_no_eligible_node')

  const list = await app.inject({
    url: `/fleets/${account.fleet.id}/databases?project=api-test`,
    headers: headers(),
  })
  assert.equal(list.statusCode, 200, list.body)
  assert.deepEqual(list.json().databases, [])
})
