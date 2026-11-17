import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createContext,
  closeContext,
  type AppContext,
} from '../src/api/context.js'
import { loadConfig } from '../src/config.js'
import {
  databaseCredentials,
  databaseLinks,
  fleets,
  orgs,
  secrets,
  services,
  tenantDatabases,
  users,
} from '../src/db/schema.js'
import { databaseEnginePlugin } from '../src/databases/engines.js'
import { linkDatabase, unlinkDatabase } from '../src/databases/links.js'
import { buildEnv } from '../src/secrets/store.js'
import { sealSecret } from '../src/lib/crypto.js'

let ctx: AppContext
const orgId = randomUUID()
const fleetId = randomUUID()
const userId = randomUUID()
const databaseId = randomUUID()
const secondDatabaseId = randomUUID()
const serviceId = randomUUID()
const owner = { orgId, userId }
const password = randomBytes(32).toString('base64url')

before(async () => {
  ctx = createContext(loadConfig())
  await ctx.db
    .insert(users)
    .values({ id: userId, email: `database-links-${userId}@example.test` })
  await ctx.db
    .insert(orgs)
    .values({ id: orgId, name: `database-links-${orgId}` })
  await ctx.db.insert(fleets).values({ id: fleetId, orgId, name: 'links-test' })
  await ctx.db.insert(tenantDatabases).values({
    id: databaseId,
    fleetId,
    project: 'links-test',
    name: 'primary',
    engine: 'postgres',
    version: '16',
    volumeName: `fleet-db-${databaseId}`,
    memoryMb: 512,
    cpu: 0.5,
    diskMb: 1024,
    status: 'running',
    images: {
      primary: `ghcr.io/fleet-os/postgres:16@sha256:${'a'.repeat(64)}`,
      pooler: `ghcr.io/fleet-os/pgbouncer:1@sha256:${'b'.repeat(64)}`,
    },
  })
  await ctx.db.insert(tenantDatabases).values({
    id: secondDatabaseId,
    fleetId,
    project: 'links-test',
    name: 'analytics',
    engine: 'postgres',
    version: '16',
    volumeName: `fleet-db-${secondDatabaseId}`,
    memoryMb: 512,
    cpu: 0.5,
    diskMb: 1024,
    status: 'running',
    images: {
      primary: `ghcr.io/fleet-os/postgres:16@sha256:${'c'.repeat(64)}`,
      pooler: `ghcr.io/fleet-os/pgbouncer:1@sha256:${'d'.repeat(64)}`,
    },
  })
  await ctx.db.insert(services).values({
    id: serviceId,
    fleetId,
    project: 'links-test',
    name: 'web',
    requestRamMb: 256,
  })
  const credentials = databaseEnginePlugin('postgres').credentials()
  credentials.owner = { username: 'fleet_owner', password }
  credentials.app = {
    username: 'fleet_app',
    password: randomBytes(32).toString('base64url'),
  }
  credentials.readonly = {
    username: 'fleet_readonly',
    password: randomBytes(32).toString('base64url'),
  }
  await ctx.db.insert(databaseCredentials).values(
    (['owner', 'app', 'readonly'] as const).map((role) => ({
      databaseId,
      role,
      generation: 1,
      encryptedValue: sealSecret(
        JSON.stringify(credentials[role]),
        ctx.config.SECRETS_MASTER_KEY,
      ),
    })),
  )
  await ctx.db.insert(databaseCredentials).values(
    (['owner', 'app', 'readonly'] as const).map((role) => ({
      databaseId: secondDatabaseId,
      role,
      generation: 1,
      encryptedValue: sealSecret(
        JSON.stringify({
          ...credentials[role],
          password: randomBytes(32).toString('base64url'),
        }),
        ctx.config.SECRETS_MASTER_KEY,
      ),
    })),
  )
})

after(async () => {
  await ctx.db
    .delete(tenantDatabases)
    .where(eq(tenantDatabases.fleetId, fleetId))
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await ctx.db.delete(users).where(eq(users.id, userId))
  await closeContext(ctx)
})

test('links inject encrypted role URLs, report redeploy, reject duplicates, and unlink cleanly', async () => {
  const result = await linkDatabase(
    ctx,
    fleetId,
    'links-test',
    databaseId,
    { serviceId },
    owner,
  )
  assert.equal(result.link.restartRequired, false)
  assert.deepEqual(Object.keys(result.link.envKeys).sort(), [
    'DATABASE_URL',
    'DIRECT_URL',
  ])
  assert.equal(JSON.stringify(result).includes(password), false)

  const [service] = await ctx.db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
  assert.equal(service!.env.DATABASE_URL, '${secret:DATABASE_URL}')
  assert.equal(service!.env.DIRECT_URL, '${secret:DIRECT_URL}')
  const resolved = await buildEnv(ctx, fleetId, service!)
  assert.match(
    resolved.env.DATABASE_URL!,
    /fleet_app:[A-Za-z0-9_-]+@primary-pool\.fleet\.internal/,
  )
  assert.match(
    resolved.env.DIRECT_URL!,
    new RegExp(`fleet_owner:${password}@primary\\.fleet\\.internal`),
  )
  assert.equal(JSON.stringify(service!.env).includes(password), false)

  const [secret] = await ctx.db
    .select()
    .from(secrets)
    .where(eq(secrets.serviceId, serviceId))
  assert.ok(secret)
  assert.equal(JSON.stringify(secret.encryptedValue).includes(password), false)
  assert.equal(
    (
      await ctx.db
        .select()
        .from(databaseLinks)
        .where(eq(databaseLinks.databaseId, databaseId))
    ).length,
    1,
  )

  await assert.rejects(
    () =>
      linkDatabase(
        ctx,
        fleetId,
        'links-test',
        databaseId,
        { serviceId },
        owner,
      ),
    /already linked/,
  )
  await unlinkDatabase(ctx, fleetId, 'links-test', databaseId, serviceId, owner)
  const [afterUnlink] = await ctx.db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
  assert.deepEqual(afterUnlink!.env, {})
  assert.deepEqual(afterUnlink!.secretRefs, [])
  assert.equal(
    (
      await ctx.db
        .select()
        .from(secrets)
        .where(eq(secrets.serviceId, serviceId))
    ).length,
    0,
  )
  assert.equal(
    (
      await ctx.db
        .select()
        .from(databaseLinks)
        .where(eq(databaseLinks.databaseId, databaseId))
    ).length,
    0,
  )
})

test('link avoids replacing an existing DATABASE_URL by using the database prefix', async () => {
  await ctx.db
    .update(services)
    .set({ env: { DATABASE_URL: 'existing' } })
    .where(eq(services.id, serviceId))
  const result = await linkDatabase(
    ctx,
    fleetId,
    'links-test',
    databaseId,
    { serviceId },
    owner,
  )
  assert.deepEqual(Object.keys(result.link.envKeys).sort(), [
    'PRIMARY_DATABASE_URL',
    'PRIMARY_DIRECT_URL',
  ])
  await unlinkDatabase(ctx, fleetId, 'links-test', databaseId, serviceId, owner)
  const [service] = await ctx.db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
  assert.deepEqual(service!.env, { DATABASE_URL: 'existing' })
})

test('concurrent links to one service keep both sets of env keys', async () => {
  await ctx.db
    .update(services)
    .set({ env: {}, secretRefs: [] })
    .where(eq(services.id, serviceId))
  const links = await Promise.all([
    linkDatabase(ctx, fleetId, 'links-test', databaseId, { serviceId }, owner),
    linkDatabase(
      ctx,
      fleetId,
      'links-test',
      secondDatabaseId,
      { serviceId },
      owner,
    ),
  ])
  assert.equal(
    new Set(links.map((value) => Object.keys(value.link.envKeys)[0])).size,
    2,
  )
  const [service] = await ctx.db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
  assert.equal(Object.keys(service!.env).length, 4)
  await Promise.all([
    unlinkDatabase(ctx, fleetId, 'links-test', databaseId, serviceId, owner),
    unlinkDatabase(
      ctx,
      fleetId,
      'links-test',
      secondDatabaseId,
      serviceId,
      owner,
    ),
  ])
  const [afterUnlink] = await ctx.db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
  assert.deepEqual(afterUnlink!.env, {})
})
